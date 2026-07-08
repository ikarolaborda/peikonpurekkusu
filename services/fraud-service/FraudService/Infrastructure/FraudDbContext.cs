using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace Peikon.Fraud.Infrastructure;

public sealed class FraudLog
{
    public Guid Id { get; init; } = Guid.CreateVersion7();
    public required string PaymentId { get; init; }
    public required string UserId { get; init; }
    public required string Decision { get; init; }
    public int RiskScore { get; init; }
    public required string ModelVersion { get; init; }
    public required JsonDocument FeaturesSnapshot { get; init; }
    public required JsonDocument RuleOutcomes { get; init; }
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
}

public sealed class ProcessedEvent
{
    public required Guid EventId { get; init; }
    public DateTimeOffset ProcessedAt { get; init; } = DateTimeOffset.UtcNow;
}

/// <summary>Debezium-compatible outbox row (same columns as the Go services).</summary>
public sealed class OutboxEvent
{
    public Guid Id { get; init; } = Guid.CreateVersion7();
    public required string AggregateType { get; init; }
    public required string AggregateId { get; init; }
    public required string Type { get; init; }
    public required JsonDocument Payload { get; init; }
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? ProcessedAt { get; set; }
}

public sealed class FraudDbContext(DbContextOptions<FraudDbContext> options) : DbContext(options)
{
    public DbSet<FraudLog> FraudLogs => Set<FraudLog>();
    public DbSet<ProcessedEvent> ProcessedEvents => Set<ProcessedEvent>();
    public DbSet<OutboxEvent> Outbox => Set<OutboxEvent>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<FraudLog>(e =>
        {
            e.ToTable("fraud_logs");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.PaymentId).HasColumnName("payment_id");
            e.Property(x => x.UserId).HasColumnName("user_id");
            e.Property(x => x.Decision).HasColumnName("decision");
            e.Property(x => x.RiskScore).HasColumnName("risk_score");
            e.Property(x => x.ModelVersion).HasColumnName("model_version");
            e.Property(x => x.FeaturesSnapshot).HasColumnName("features_snapshot").HasColumnType("jsonb");
            e.Property(x => x.RuleOutcomes).HasColumnName("rule_outcomes").HasColumnType("jsonb");
            e.Property(x => x.CreatedAt).HasColumnName("created_at");
            e.HasIndex(x => x.PaymentId);
        });

        b.Entity<ProcessedEvent>(e =>
        {
            e.ToTable("processed_events");
            e.HasKey(x => x.EventId);
            e.Property(x => x.EventId).HasColumnName("event_id");
            e.Property(x => x.ProcessedAt).HasColumnName("processed_at");
        });

        b.Entity<OutboxEvent>(e =>
        {
            e.ToTable("outbox");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.AggregateType).HasColumnName("aggregatetype");
            e.Property(x => x.AggregateId).HasColumnName("aggregateid");
            e.Property(x => x.Type).HasColumnName("type");
            e.Property(x => x.Payload).HasColumnName("payload").HasColumnType("jsonb");
            e.Property(x => x.CreatedAt).HasColumnName("created_at");
            e.Property(x => x.ProcessedAt).HasColumnName("processed_at");
            e.HasIndex(x => x.ProcessedAt).HasFilter("processed_at is null");
        });
    }
}
