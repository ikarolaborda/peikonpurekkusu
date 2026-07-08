// mock-psp simulates the external payment gateway/processor (the Visa/
// PayPal-shaped box in the architecture). Deterministic by design so retries
// and tests see stable behavior:
//
//   - amounts whose last two digits are 42  → hard decline (card_declined)
//   - amounts whose last two digits are 13  → transient 503 (exercises
//     retry + circuit breaker; succeeds when MOCK_PSP_FAILURE_RATE < 1)
//   - method=wallet → 202 pending, result published asynchronously to
//     gateway.psp.completed.v1 (the async Gateway Response Queue flow)
//   - everything else → approved after MOCK_PSP_LATENCY_MS
//
// Idempotent by reference: repeated /authorize for the same reference returns
// the recorded outcome.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

type authorizeReq struct {
	Reference   string `json:"reference"`
	AmountMinor int64  `json:"amount_minor_units"`
	Currency    string `json:"currency_code"`
	Method      string `json:"method"`
	Token       string `json:"token"`
}

type authorizeResp struct {
	PSPReference string `json:"psp_reference"`
	Outcome      string `json:"outcome"`
	DeclineCode  string `json:"decline_code,omitempty"`
	Pending      bool   `json:"pending,omitempty"`
}

type server struct {
	log        *slog.Logger
	latency    time.Duration
	failRate   float64
	producer   *kgo.Client
	registry   string
	schemaIDs  sync.Map // topic → int32
	mu         sync.Mutex
	authorized map[string]authorizeResp
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		client := &http.Client{Timeout: 3 * time.Second}
		resp, err := client.Get("http://localhost:8080/health/ready")
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	latencyMs, _ := strconv.Atoi(getenv("MOCK_PSP_LATENCY_MS", "120"))
	failRate, _ := strconv.ParseFloat(getenv("MOCK_PSP_FAILURE_RATE", "0.05"), 64)

	s := &server{
		log:        log,
		latency:    time.Duration(latencyMs) * time.Millisecond,
		failRate:   failRate,
		registry:   getenv("SCHEMA_REGISTRY_URL", "http://apicurio-registry:8080/apis/ccompat/v7"),
		authorized: map[string]authorizeResp{},
	}

	// Kafka is optional: without it the wallet async flow is disabled but
	// card flows still work (keeps the service standalone-testable).
	if brokers := getenv("KAFKA_BOOTSTRAP_SERVERS", ""); brokers != "" {
		client, err := kgo.NewClient(kgo.SeedBrokers(brokers), kgo.RequiredAcks(kgo.AllISRAcks()))
		if err != nil {
			log.Error("kafka client failed — wallet async flow disabled", "error", err)
		} else {
			s.producer = client
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", ok)
	mux.HandleFunc("GET /health/ready", ok)
	mux.HandleFunc("POST /authorize", s.authorize)
	mux.HandleFunc("POST /capture/{ref}", s.capture)
	mux.HandleFunc("POST /reverse/{ref}", s.reverse)

	log.Info("mock-psp listening", "port", 8080, "latency", s.latency, "failure_rate", s.failRate)
	srv := &http.Server{Addr: ":8080", Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	if err := srv.ListenAndServe(); err != nil {
		log.Error("serve", "error", err)
		os.Exit(1)
	}
}

func (s *server) authorize(w http.ResponseWriter, r *http.Request) {
	var req authorizeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Reference == "" {
		http.Error(w, `{"detail":"bad request"}`, http.StatusBadRequest)
		return
	}
	time.Sleep(s.latency)

	// Idempotent replay by reference.
	s.mu.Lock()
	if prev, seen := s.authorized[req.Reference]; seen {
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, prev)
		return
	}
	s.mu.Unlock()

	// Transient failure band: deterministic trigger via amount, plus a
	// random component controlled by MOCK_PSP_FAILURE_RATE.
	if req.AmountMinor%100 == 13 && rand.Float64() < s.failRate*10 {
		http.Error(w, `{"detail":"upstream processor timeout"}`, http.StatusServiceUnavailable)
		return
	}

	resp := authorizeResp{PSPReference: "psp_" + req.Reference}
	switch {
	case req.AmountMinor%100 == 42:
		resp.Outcome = "declined"
		resp.DeclineCode = "card_declined"
	case req.Method == "wallet":
		resp.Outcome = "pending"
		resp.Pending = true
		go s.completeAsync(req)
	default:
		resp.Outcome = "approved"
	}

	s.mu.Lock()
	s.authorized[req.Reference] = resp
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, resp)
}

// completeAsync emulates the wallet provider webhook: after a short delay it
// publishes the outcome to gateway.psp.completed.v1 (Confluent-framed).
func (s *server) completeAsync(req authorizeReq) {
	if s.producer == nil {
		s.log.Warn("wallet result NOT published — no kafka", "reference", req.Reference)
		return
	}
	time.Sleep(s.latency * 4)

	outcome := "approved"
	declineCode := ""
	if req.AmountMinor%100 == 43 { // deterministic async decline band
		outcome, declineCode = "declined", "wallet_rejected"
	}

	topic := "gateway.psp.completed.v1"
	schemaID, err := s.schemaID(topic)
	if err != nil {
		s.log.Error("schema lookup failed — wallet result dropped", "error", err)
		return
	}
	envelope := map[string]any{
		"event_id":       deterministicUUID(req.Reference),
		"event_type":     topic,
		"schema_version": 1,
		"occurred_at":    time.Now().UTC().Format(time.RFC3339),
		"tenant_id":      "peikon",
		"correlation_id": fmt.Sprintf("%x", sha256.Sum256([]byte(req.Reference)))[:32],
		"causation_id":   nil,
		"idempotency_key": nil,
		"payload": map[string]any{
			"psp_reference":      "psp_" + req.Reference,
			"payment_id":         req.Reference,
			"outcome":            outcome,
			"decline_code":       nullable(declineCode),
			"amount_minor_units": req.AmountMinor,
			"currency_code":      req.Currency,
		},
	}
	body, _ := json.Marshal(envelope)
	value := make([]byte, 5, 5+len(body))
	value[0] = 0
	binary.BigEndian.PutUint32(value[1:5], uint32(schemaID))
	value = append(value, body...)

	if err := s.producer.ProduceSync(context.Background(), &kgo.Record{
		Topic: topic, Key: []byte(req.Reference), Value: value,
	}).FirstErr(); err != nil {
		s.log.Error("wallet result publish failed", "error", err)
		return
	}
	s.log.Info("wallet result published", "reference", req.Reference, "outcome", outcome)
}

func (s *server) capture(w http.ResponseWriter, r *http.Request) {
	time.Sleep(s.latency / 2)
	writeJSON(w, http.StatusOK, map[string]any{"captured": true, "reference": r.PathValue("ref")})
}

func (s *server) reverse(w http.ResponseWriter, r *http.Request) {
	time.Sleep(s.latency / 2)
	writeJSON(w, http.StatusOK, map[string]any{"reversed": true, "reference": r.PathValue("ref")})
}

func (s *server) schemaID(topic string) (int32, error) {
	if v, ok := s.schemaIDs.Load(topic); ok {
		return v.(int32), nil
	}
	resp, err := http.Get(fmt.Sprintf("%s/subjects/%s-value/versions/latest", s.registry, topic))
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 128))
		return 0, fmt.Errorf("registry HTTP %d: %s", resp.StatusCode, b)
	}
	var out struct {
		ID int32 `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, err
	}
	s.schemaIDs.Store(topic, out.ID)
	return out.ID, nil
}

// deterministicUUID derives a stable uuid-shaped id from the reference so
// consumer-side dedup also guards against duplicate async completions.
func deterministicUUID(ref string) string {
	h := sha256.Sum256([]byte("psp-completed:" + ref))
	hexs := fmt.Sprintf("%x", h)
	return fmt.Sprintf("%s-%s-4%s-8%s-%s", hexs[0:8], hexs[8:12], hexs[13:16], hexs[17:20], hexs[20:32])
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func ok(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
