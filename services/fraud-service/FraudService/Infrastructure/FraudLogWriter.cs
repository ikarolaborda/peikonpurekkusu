using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;

namespace Peikon.Fraud.Infrastructure;

/// <summary>
/// Decouples fraud-log persistence from the gRPC hot path: Score() enqueues
/// and returns inside its latency budget; this background service drains the
/// bounded channel in batches. Back-pressure policy: when the channel is
/// full, the oldest waiting entry is dropped (scoring availability beats log
/// completeness; the decision itself was already returned).
/// </summary>
public sealed class FraudLogWriter(IServiceScopeFactory scopes, ILogger<FraudLogWriter> log) : BackgroundService
{
    private readonly Channel<FraudLog> _channel = Channel.CreateBounded<FraudLog>(
        new BoundedChannelOptions(2048) { FullMode = BoundedChannelFullMode.DropOldest });

    public bool TryEnqueue(FraudLog entry) => _channel.Writer.TryWrite(entry);

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var batch = new List<FraudLog>(100);
        while (await _channel.Reader.WaitToReadAsync(ct).ConfigureAwait(false))
        {
            batch.Clear();
            while (batch.Count < 100 && _channel.Reader.TryRead(out var entry))
            {
                batch.Add(entry);
            }
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                var db = scope.ServiceProvider.GetRequiredService<FraudDbContext>();
                db.FraudLogs.AddRange(batch);
                await db.SaveChangesAsync(ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogError(ex, "fraud log batch persist failed ({Count} entries lost)", batch.Count);
            }
        }
    }
}
