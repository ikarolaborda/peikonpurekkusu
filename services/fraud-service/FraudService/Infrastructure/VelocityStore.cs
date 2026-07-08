using StackExchange.Redis;

namespace Peikon.Fraud.Infrastructure;

/// <summary>
/// Exact sliding-window velocity counters in Redis (redis-cache instance).
/// One atomic Lua script trims the window, records the event and returns
/// count + amount sum — memory stays bounded (trim + PEXPIRE every call).
/// Windows use EVENT time, not ingest time.
/// </summary>
public interface IVelocityStore
{
    /// <returns>(countInWindow, amountSumInWindow) including this event, or null when Redis missed the budget.</returns>
    Task<(long Count, long AmountSum)?> RecordAndCountAsync(
        string accountId, string paymentId, long amountMinorUnits, DateTimeOffset eventTime, TimeSpan window, CancellationToken ct);

    Task<bool?> IsDenylistedAsync(string userId, CancellationToken ct);
    Task<string[]?> RecentCountriesAsync(string userId, string currentCountry, CancellationToken ct);
}

public sealed class VelocityStore(IConnectionMultiplexer redis, TimeSpan budget) : IVelocityStore
{
    // KEYS[1]=zset key, ARGV: now_ms, window_ms, member, amount
    private const string Script = """
        redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1] - ARGV[2])
        redis.call('ZADD', KEYS[1], ARGV[1], ARGV[3])
        redis.call('PEXPIRE', KEYS[1], ARGV[2])
        local members = redis.call('ZRANGE', KEYS[1], 0, -1)
        local sum = 0
        for _, m in ipairs(members) do
          local amt = string.match(m, ':(%d+)$')
          if amt then sum = sum + tonumber(amt) end
        end
        return {#members, sum}
        """;

    public async Task<(long, long)?> RecordAndCountAsync(
        string accountId, string paymentId, long amountMinorUnits, DateTimeOffset eventTime, TimeSpan window, CancellationToken ct)
    {
        try
        {
            var db = redis.GetDatabase();
            var task = db.ScriptEvaluateAsync(Script,
                [new RedisKey($"velocity:{accountId}")],
                [eventTime.ToUnixTimeMilliseconds(), (long)window.TotalMilliseconds, $"{paymentId}:{amountMinorUnits}"]);
            var result = await task.WaitAsync(budget, ct);
            var parts = (RedisResult[])result!;
            return ((long)parts[0], (long)parts[1]);
        }
        catch (Exception) // timeout or connectivity — the caller applies its fail policy
        {
            return null;
        }
    }

    public async Task<bool?> IsDenylistedAsync(string userId, CancellationToken ct)
    {
        try
        {
            var db = redis.GetDatabase();
            return await db.SetContainsAsync("fraud:denylist", userId).WaitAsync(budget, ct);
        }
        catch (Exception)
        {
            return null;
        }
    }

    public async Task<string[]?> RecentCountriesAsync(string userId, string currentCountry, CancellationToken ct)
    {
        try
        {
            var db = redis.GetDatabase();
            var key = $"fraud:countries:{userId}";
            var known = await db.SetMembersAsync(key).WaitAsync(budget, ct);
            if (!string.IsNullOrEmpty(currentCountry))
            {
                _ = db.SetAddAsync(key, currentCountry, CommandFlags.FireAndForget);
                _ = db.KeyExpireAsync(key, TimeSpan.FromDays(30), CommandFlags.FireAndForget);
            }
            return known.Select(v => (string)v!).ToArray();
        }
        catch (Exception)
        {
            return null;
        }
    }
}
