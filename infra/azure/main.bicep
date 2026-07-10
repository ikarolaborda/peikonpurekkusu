// peikonpurekkusu — Azure provisioning (subscription-scope entrypoint).
// Managed backing services replace the compose containers 1:1:
//   Kafka        → Event Hubs (Kafka-compatible endpoint, SASL_SSL/OAUTHBEARER)
//   PostgreSQL×N → Azure Database for PostgreSQL Flexible Server (DB per service)
//   Redis        → Azure Managed Redis (Azure Cache for Redis is retiring)
//   registry     → Apicurio on Container Apps (no managed equivalent)
//   services     → Azure Container Apps (KEDA autoscale, min 1 on hot paths)
//   secrets      → Key Vault + per-service user-assigned managed identities
//   images       → Azure Container Registry
//
// This is a deployable skeleton: it provisions the platform (env, registry,
// data, identity, secrets). Container App definitions are generated/updated by
// `azd deploy` from azure.yaml. See docs/azure.md.
targetScope = 'subscription'

@description('Environment name (azd) — prefixes all resource names.')
param environmentName string

@description('Primary location for all resources.')
param location string = 'westeurope'

@description('PostgreSQL administrator login.')
param pgAdminUser string = 'peikon_admin'

@secure()
@description('PostgreSQL administrator password (supply via azd env / pipeline secret).')
param pgAdminPassword string

var tags = { 'azd-env-name': environmentName, application: 'peikonpurekkusu' }
var rgName = 'rg-${environmentName}'

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: rgName
  location: location
  tags: tags
}

module platform 'platform.bicep' = {
  name: 'platform'
  scope: rg
  params: {
    environmentName: environmentName
    location: location
    tags: tags
    pgAdminUser: pgAdminUser
    pgAdminPassword: pgAdminPassword
  }
}

output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP string = rgName
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = platform.outputs.acrLoginServer
output AZURE_CONTAINER_APPS_ENVIRONMENT_ID string = platform.outputs.containerAppsEnvId
output EVENTHUBS_NAMESPACE string = platform.outputs.eventHubsNamespace
output KEY_VAULT_NAME string = platform.outputs.keyVaultName
