// audit-service — full event-firehose consumer → append-only audit store.
// AUDIT_SINK selects postgres (default) or cassandra.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
	"github.com/twmb/franz-go/pkg/kgo"

	audit "github.com/peikonpurekkusu/audit-service"
	"github.com/peikonpurekkusu/audit-service/internal/consumer"
	"github.com/peikonpurekkusu/audit-service/internal/platform"
	"github.com/peikonpurekkusu/audit-service/internal/sink"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(selfProbe())
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)
	if err := run(log); err != nil {
		log.Error("fatal", "error", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := platform.Load()
	if err != nil {
		return err
	}

	// ── Sink selection (Adapter) — connect only the chosen store ────────────
	var auditSink sink.Sink
	switch cfg.Sink {
	case "cassandra":
		cs, err := sink.NewCassandra(cfg.CassandraHosts, cfg.CassandraKeyspace)
		if err != nil {
			return fmt.Errorf("cassandra sink: %w", err)
		}
		auditSink = cs
		log.Info("audit sink: cassandra", "hosts", cfg.CassandraHosts)
	default:
		pool, err := pgxpool.New(ctx, cfg.DSN())
		if err != nil {
			return fmt.Errorf("pgx pool: %w", err)
		}
		if err := migrate(ctx, cfg); err != nil {
			return fmt.Errorf("migrations: %w", err)
		}
		auditSink = sink.NewPostgres(pool)
		log.Info("audit sink: postgres (partitioned)")
	}
	defer auditSink.Close()

	producer, err := kgo.NewClient(
		kgo.SeedBrokers(cfg.KafkaBootstrap),
		kgo.RequiredAcks(kgo.AllISRAcks()),
	)
	if err != nil {
		return fmt.Errorf("kafka producer: %w", err)
	}
	defer producer.Close()

	cons, err := consumer.New([]string{cfg.KafkaBootstrap}, cfg.Topics, auditSink, producer, log)
	if err != nil {
		return fmt.Errorf("kafka consumer: %w", err)
	}
	defer cons.Close()
	go cons.Run(ctx)

	// ── Health-only HTTP ─────────────────────────────────────────────────────
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		rctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if err := auditSink.Ready(rctx); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"sink": "down"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"sink": "up"})
	})
	srv := &http.Server{Addr: fmt.Sprintf(":%d", cfg.HTTPPort), Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		log.Info("HTTP listening", "port", cfg.HTTPPort)
		_ = srv.ListenAndServe()
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shCtx)
	return nil
}

func migrate(ctx context.Context, cfg platform.Config) error {
	sqlDB, err := goose.OpenDBWithDriver("pgx", cfg.DSN())
	if err != nil {
		return err
	}
	defer sqlDB.Close()
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return err
	}
	migrations, err := fs.Sub(audit.MigrationsFS, "migrations")
	if err != nil {
		return err
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations, goose.WithSessionLocker(locker))
	if err != nil {
		return err
	}
	_, err = provider.Up(ctx)
	return err
}

func selfProbe() int {
	port := os.Getenv("HTTP_PORT")
	if port == "" {
		port = "8080"
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://localhost:" + port + "/health/ready")
	if err != nil || resp.StatusCode != http.StatusOK {
		return 1
	}
	resp.Body.Close()
	return 0
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
