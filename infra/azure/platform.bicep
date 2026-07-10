// Resource-group-scoped platform for peikonpurekkusu.
@description('azd environment name.')
param environmentName string
param location string
param tags object
param pgAdminUser string
@secure()
param pgAdminPassword string

var prefix = replace(toLower(environmentName), '_', '')
var uniq = uniqueString(subscription().id, resourceGroup().id)

// ── Observability backbone ───────────────────────────────────────────────────
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${prefix}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ── Azure Container Registry ─────────────────────────────────────────────────
resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: 'acr${prefix}${uniq}'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    adminUserEnabled: false // pull via managed identity (AcrPull), never admin creds
  }
}

// ── Container Apps environment ───────────────────────────────────────────────
resource caeEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${prefix}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    zoneRedundant: false // flip on for production HA
  }
}

// ── Key Vault ────────────────────────────────────────────────────────────────
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-${prefix}-${take(uniq, 8)}'
  location: location
  tags: tags
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true // grant services Key Vault Secrets User via RBAC
    enableSoftDelete: true
  }
}

// ── Event Hubs (Kafka-compatible) ────────────────────────────────────────────
// Standard tier exposes the Kafka endpoint on :9093 (SASL_SSL). Services keep
// their KAFKA_BOOTSTRAP_SERVERS env — only the value + SASL settings change.
resource ehNamespace 'Microsoft.EventHub/namespaces@2024-01-01' = {
  name: 'evhns-${prefix}-${take(uniq, 8)}'
  location: location
  tags: tags
  sku: { name: 'Standard', tier: 'Standard', capacity: 1 }
  properties: {
    kafkaEnabled: true
    zoneRedundant: false
  }
}

// One event hub (Kafka topic) per domain topic. Partitions match the dev
// compose (3). Topic list mirrors infra/kafka/create-topics.sh.
var topics = [
  'payments.payment.requested.v1'
  'payments.payment.authorized.v1'
  'payments.payment.captured.v1'
  'payments.payment.failed.v1'
  'payments.payment.reversed.v1'
  'accounts.funds.held.v1'
  'accounts.funds.captured.v1'
  'accounts.funds.released.v1'
  'transactions.transaction.recorded.v1'
  'fraud.score.approved.v1'
  'fraud.score.denied.v1'
  'fraud.score.flagged.v1'
  'identity.user.registered.v1'
  'identity.user.session_revoked.v1'
  'notifications.notification.requested.v1'
  'notifications.notification.delivered.v1'
  'notifications.notification.failed.v1'
  'gateway.psp.completed.v1'
]

resource hubs 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = [
  for t in topics: {
    parent: ehNamespace
    name: t
    properties: {
      partitionCount: 3
      messageRetentionInDays: 7 // Standard cap; Premium/Dedicated for longer
    }
  }
]

// ── PostgreSQL Flexible Server (database per service) ────────────────────────
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'psql-${prefix}-${take(uniq, 8)}'
  location: location
  tags: tags
  sku: { name: 'Standard_B2s', tier: 'Burstable' } // scale up + zone-redundant HA for prod
  properties: {
    version: '18'
    administratorLogin: pgAdminUser
    administratorLoginPassword: pgAdminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' } // 'ZoneRedundant' for production
  }
}

var databases = ['users', 'accounts', 'payments', 'transactions', 'fraud', 'notifications', 'audit', 'registry']
resource pgDbs 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = [
  for db in databases: {
    parent: pg
    name: db
  }
]

// ── Azure Managed Redis ──────────────────────────────────────────────────────
// One instance; the app separates session vs cache by key prefix / logical DB.
// (Azure Cache for Redis is retiring — Managed Redis from day one.)
resource redis 'Microsoft.Cache/redisEnterprise@2024-06-01-preview' = {
  name: 'redis-${prefix}-${take(uniq, 8)}'
  location: location
  tags: tags
  sku: { name: 'Balanced_B0' }
}

output acrLoginServer string = acr.properties.loginServer
output containerAppsEnvId string = caeEnv.id
output eventHubsNamespace string = ehNamespace.name
output keyVaultName string = kv.name
output postgresHost string = pg.properties.fullyQualifiedDomainName
