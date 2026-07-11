using System.Text.Json;
using Confluent.Kafka;
using Microsoft.EntityFrameworkCore;

namespace Peikon.Fraud.Infrastructure;

/// <summary>
/// Post-capture deep analysis: consumes payments.payment.captured.v1 and
/// looks for patterns the inline path can't afford (per-account daily volume
/// today; impossible-travel and cross-account graphs are the growth path).
/// Anomalies emit fraud.score.flagged.v1 through the outbox. Idempotent via
/// processed_events; poison → per-group DLQ; offsets stored only after a
/// durable write (EnableAutoOffsetStore=false).
/// </summary>
public sealed class DeepAnalysisConsumer(IServiceScopeFactory scopes, IProducer<string, byte[]> producer,
    IConfiguration config, ILogger<DeepAnalysisConsumer> log) : BackgroundService
{
    private const string Group = "fraud-service";
    private const string Topic = "payments.payment.captured.v1";
    private const long DailyVolumeFlagThreshold = 400_000; // minor units per account per day

    protected override Task ExecuteAsync(CancellationToken ct) =>
        Task.Factory.StartNew(() => RunLoop(ct), ct, TaskCreationOptions.LongRunning, TaskScheduler.Default);

    private void RunLoop(CancellationToken ct)
    {
        var consumerConfig = new ConsumerConfig
        {
            BootstrapServers = config["KAFKA_BOOTSTRAP_SERVERS"] ?? "kafka:19092",
            GroupId = Group,
            AutoOffsetReset = AutoOffsetReset.Earliest,
            EnableAutoCommit = true,
            EnableAutoOffsetStore = false,
        };
        using var consumer = new ConsumerBuilder<string, byte[]>(consumerConfig).Build();
        consumer.Subscribe(Topic);
        log.LogInformation("deep-analysis consumer subscribed to {Topic}", Topic);

        while (!ct.IsCancellationRequested)
        {
            try
            {
                var result = consumer.Consume(ct);
                if (result is null) continue;
                var handled = HandleWithRetryAsync(result, ct).GetAwaiter().GetResult();
                if (handled)
                {
                    consumer.StoreOffset(result);
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (ConsumeException ex)
            {
                log.LogError(ex, "consume error");
                Thread.Sleep(1000);
            }
        }
        consumer.Close();
    }

    private async Task<bool> HandleWithRetryAsync(ConsumeResult<string, byte[]> result, CancellationToken ct)
    {
        Exception? last = null;
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                await HandleAsync(result, ct);
                return true;
            }
            catch (PoisonEventException ex)
            {
                // Retrying cannot fix it, and the DLQ result decides the offset:
                // discarding it here would drop the message when the DLQ write fails.
                return await DeadLetterAsync(result, ex.InnerException ?? ex, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                last = ex;
                log.LogWarning(ex, "deep analysis failed (attempt {Attempt})", attempt);
                await Task.Delay(attempt * 200, ct);
            }
        }
        // Advance the offset only if the message is safely in the DLQ.
        return await DeadLetterAsync(result, last, ct);
    }

    private async Task HandleAsync(ConsumeResult<string, byte[]> result, CancellationToken ct)
    {
        var envelope = EventsCodec.TryUnframe(result.Message.Value);
        if (envelope is null || !Guid.TryParse(envelope.EventId, out var eventId))
        {
            throw new PoisonEventException(new FormatException("unparseable envelope"));
        }

        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<FraudDbContext>();
        await using var tx = await db.Database.BeginTransactionAsync(ct);

        db.ProcessedEvents.Add(new ProcessedEvent { EventId = eventId });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.IsUniqueViolation())
        {
            return; // genuinely already processed
        }
        // Any other DbUpdateException (deadlock, timeout, broken connection) is a
        // real failure: let it bubble so the event is retried, not silently acked.

        var userId = (string?)envelope.Payload["user_id"] ?? "";
        var paymentId = (string?)envelope.Payload["payment_id"] ?? "";
        var amount = (long?)envelope.Payload["amount_minor_units"] ?? 0;

        // Daily captured volume per user, derived from the inline path's own
        // fraud_logs (features_snapshot carries the amount) — no extra table.
        // Bound must be a UTC DateTimeOffset for the timestamptz column.
        var since = new DateTimeOffset(DateTime.UtcNow.Date, TimeSpan.Zero);
        var volumeToday = await db.Database
            .SqlQuery<long>($"""
                select coalesce(sum((features_snapshot->>'AmountMinorUnits')::bigint), 0) as "Value"
                  from fraud_logs
                 where user_id = {userId} and created_at >= {since}
                """)
            .FirstAsync(ct);

        if (volumeToday + amount > DailyVolumeFlagThreshold)
        {
            db.Outbox.Add(new OutboxEvent
            {
                AggregateType = "fraud",
                AggregateId = paymentId,
                Type = "fraud.score.flagged.v1",
                Payload = JsonSerializer.SerializeToDocument(new
                {
                    fraud_log_id = Guid.CreateVersion7().ToString(),
                    payment_id = paymentId,
                    user_id = userId,
                    risk_score = 80,
                    recommended_action = "review",
                    detail = $"daily captured volume {volumeToday + amount} minor units exceeds threshold",
                }),
            });
            await db.SaveChangesAsync(ct);
            log.LogWarning("account flagged for review: user {UserId} daily volume {Volume}", userId, volumeToday + amount);
        }
        await tx.CommitAsync(ct);
    }

    /// <returns>true if safely dead-lettered (offset may advance); false if the DLQ write failed (retry).</returns>
    private async Task<bool> DeadLetterAsync(ConsumeResult<string, byte[]> result, Exception? cause, CancellationToken ct)
    {
        var dlq = $"{Group}.{Topic}.dlq";
        var message = new Message<string, byte[]>
        {
            Key = result.Message.Key,
            Value = result.Message.Value,
            Headers = new Headers
            {
                { "x-exception", System.Text.Encoding.UTF8.GetBytes(cause?.Message ?? "unknown") },
                { "x-original-topic", System.Text.Encoding.UTF8.GetBytes(result.Topic) },
                { "x-original-partition", System.Text.Encoding.UTF8.GetBytes(result.Partition.Value.ToString()) },
                { "x-original-offset", System.Text.Encoding.UTF8.GetBytes(result.Offset.Value.ToString()) },
                { "x-failed-at", System.Text.Encoding.UTF8.GetBytes(DateTimeOffset.UtcNow.ToString("O")) },
                { "x-consumer-group", System.Text.Encoding.UTF8.GetBytes(Group) },
            },
        };
        try
        {
            await producer.ProduceAsync(dlq, message, ct);
            log.LogWarning("message dead-lettered to {Dlq}: {Cause}", dlq, cause?.Message);
            return true;
        }
        catch (Exception ex)
        {
            log.LogError(ex, "DLQ publish failed — leaving offset unadvanced for retry ({Cause})", cause?.Message);
            return false;
        }
    }
}
