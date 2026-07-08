package platform

import (
	"fmt"
	"os"
	"strings"
)

// Config — audit-service environment contract (names match repo .env).
type Config struct {
	Sink string // postgres | cassandra

	DBHost, DBUser, DBPassword, DBName string
	DBPort                             int

	CassandraHosts    []string
	CassandraKeyspace string

	KafkaBootstrap    string
	SchemaRegistryURL string
	Topics            []string

	HTTPPort int
}

// AllTopics is the full firehose (kept in sync with infra/kafka/create-topics.sh).
var AllTopics = []string{
	"payments.payment.requested.v1", "payments.payment.authorized.v1",
	"payments.payment.captured.v1", "payments.payment.failed.v1",
	"payments.payment.reversed.v1",
	"accounts.funds.held.v1", "accounts.funds.captured.v1", "accounts.funds.released.v1",
	"transactions.transaction.recorded.v1",
	"fraud.score.approved.v1", "fraud.score.denied.v1", "fraud.score.flagged.v1",
	"identity.user.registered.v1", "identity.user.session_revoked.v1",
	"notifications.notification.requested.v1", "notifications.notification.delivered.v1",
	"notifications.notification.failed.v1",
	"gateway.psp.completed.v1",
}

func Load() (Config, error) {
	cfg := Config{
		Sink:              getenv("AUDIT_SINK", "postgres"),
		DBHost:            getenv("AUDIT_DB_HOST", "audit-db"),
		DBPort:            getint("AUDIT_DB_PORT", 5432),
		DBUser:            os.Getenv("AUDIT_DB_USER"),
		DBPassword:        os.Getenv("AUDIT_DB_PASSWORD"),
		DBName:            os.Getenv("AUDIT_DB_NAME"),
		CassandraHosts:    splitCSV(getenv("CASSANDRA_CONTACT_POINTS", "cassandra")),
		CassandraKeyspace: getenv("CASSANDRA_KEYSPACE", "audit"),
		KafkaBootstrap:    getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:19092"),
		SchemaRegistryURL: getenv("SCHEMA_REGISTRY_URL", "http://apicurio-registry:8080/apis/ccompat/v7"),
		Topics:            AllTopics,
		HTTPPort:          getint("HTTP_PORT", 8080),
	}
	if topics := os.Getenv("AUDIT_TOPICS"); topics != "" {
		cfg.Topics = splitCSV(topics)
	}
	if cfg.Sink == "postgres" && (cfg.DBUser == "" || cfg.DBName == "") {
		return cfg, fmt.Errorf("AUDIT_DB_USER/NAME required for postgres sink")
	}
	return cfg, nil
}

func (c Config) DSN() string {
	return fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=disable",
		c.DBUser, c.DBPassword, c.DBHost, c.DBPort, c.DBName)
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func getint(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		var n int
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil {
			return n
		}
	}
	return def
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := parts[:0]
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
