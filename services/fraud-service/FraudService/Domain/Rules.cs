using Peikon.Fraud.Infrastructure;

namespace Peikon.Fraud.Domain;

/// <summary>
/// Fail policy when Redis misses its budget (Strategy): below the threshold
/// the rule contributes a "flagged, proceed" score; at/above it contributes a
/// step-up-forcing score. The gRPC caller (payment-service) applies its own
/// outage policy on top — defense in depth, both sides amount-tiered.
/// </summary>
public sealed record OutagePolicy(long FailClosedThresholdMinorUnits = 5000)
{
    public RuleOutcome OnUnavailable(string rule, FraudContext ctx) =>
        ctx.AmountMinorUnits < FailClosedThresholdMinorUnits
            ? new RuleOutcome(rule, 10, "signal store unavailable — failing open, flagged")
            : new RuleOutcome(rule, 65, "signal store unavailable — failing closed (step-up)");
}

public sealed class VelocityCountRule(IVelocityStore store, OutagePolicy outage) : IFraudRule
{
    public string Name => "velocity_count";
    public int Priority => 10;
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(10);

    public async ValueTask<RuleOutcome> EvaluateAsync(FraudContext ctx, CancellationToken ct)
    {
        var result = await store.RecordAndCountAsync(ctx.AccountId, ctx.PaymentId, ctx.AmountMinorUnits, ctx.RequestedAt, Window, ct);
        if (result is null) return outage.OnUnavailable(Name, ctx);
        return result.Value.Count switch
        {
            > 12 => new RuleOutcome(Name, 55, $"{result.Value.Count} payments in 10m"),
            > 6 => new RuleOutcome(Name, 30, $"{result.Value.Count} payments in 10m"),
            > 3 => new RuleOutcome(Name, 12, $"{result.Value.Count} payments in 10m"),
            _ => new RuleOutcome(Name, 0, "normal frequency"),
        };
    }
}

public sealed class VelocityAmountRule(IVelocityStore store, OutagePolicy outage) : IFraudRule
{
    public string Name => "velocity_amount";
    public int Priority => 11;
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(10);

    public async ValueTask<RuleOutcome> EvaluateAsync(FraudContext ctx, CancellationToken ct)
    {
        // The count rule already recorded this event; a second zset would
        // double-write, so reuse the same window via a read-modeled record
        // with zero-amount member (cheap approximation: rely on count rule's
        // write, only read the sum here). Recording again is harmless for
        // count (same member overwrites) — amounts ride in the member string.
        var result = await store.RecordAndCountAsync(ctx.AccountId, ctx.PaymentId, ctx.AmountMinorUnits, ctx.RequestedAt, Window, ct);
        if (result is null) return outage.OnUnavailable(Name, ctx);
        return result.Value.AmountSum switch
        {
            > 500_000 => new RuleOutcome(Name, 50, $"{result.Value.AmountSum} minor units in 10m"),
            > 150_000 => new RuleOutcome(Name, 25, $"{result.Value.AmountSum} minor units in 10m"),
            _ => new RuleOutcome(Name, 0, "normal volume"),
        };
    }
}

public sealed class AmountTierRule : IFraudRule
{
    public string Name => "amount_tier";
    public int Priority => 20;

    public ValueTask<RuleOutcome> EvaluateAsync(FraudContext ctx, CancellationToken ct) =>
        ValueTask.FromResult(ctx.AmountMinorUnits switch
        {
            > 5_000_000 => new RuleOutcome(Name, 45, "very large amount"),
            > 1_000_000 => new RuleOutcome(Name, 25, "large amount"),
            > 250_000 => new RuleOutcome(Name, 10, "elevated amount"),
            _ => new RuleOutcome(Name, 0, "normal amount"),
        });
}

public sealed class GeoMismatchRule(IVelocityStore store) : IFraudRule
{
    public string Name => "geo_mismatch";
    public int Priority => 30;

    public async ValueTask<RuleOutcome> EvaluateAsync(FraudContext ctx, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(ctx.CountryCode))
            return new RuleOutcome(Name, 0, "no geo signal");
        var known = await store.RecentCountriesAsync(ctx.UserId, ctx.CountryCode, ct);
        if (known is null) return new RuleOutcome(Name, 5, "geo store unavailable");
        if (known.Length > 0 && !known.Contains(ctx.CountryCode))
            return new RuleOutcome(Name, 35, $"new country {ctx.CountryCode} (known: {string.Join(',', known)})");
        return new RuleOutcome(Name, 0, "known geography");
    }
}

public sealed class DenylistRule(IVelocityStore store, OutagePolicy outage) : IFraudRule
{
    public string Name => "denylist";
    public int Priority => 5; // cheapest hard signal runs first

    public async ValueTask<RuleOutcome> EvaluateAsync(FraudContext ctx, CancellationToken ct)
    {
        var listed = await store.IsDenylistedAsync(ctx.UserId, ct);
        if (listed is null) return outage.OnUnavailable(Name, ctx);
        return listed.Value
            ? new RuleOutcome(Name, 100, "user denylisted", HardDeny: true)
            : new RuleOutcome(Name, 0, "not listed");
    }
}

/// <summary>Pluggable model hook (PredictionEnginePool-shaped in production).</summary>
public interface IFraudScorer
{
    string ModelVersion { get; }
    ValueTask<int> ScoreAsync(FraudContext ctx, CancellationToken ct);
}

/// <summary>Deterministic fallback used while FRAUD_ML_ENABLED=false.</summary>
public sealed class HeuristicScorer : IFraudScorer
{
    public string ModelVersion => "heuristic-v1";

    public ValueTask<int> ScoreAsync(FraudContext ctx, CancellationToken ct)
    {
        // Cheap, explainable proxy signals — NOT a model, only the hook's default.
        var score = 0;
        if (ctx.PaymentMethod == "card" && ctx.AmountMinorUnits % 100 == 99) score += 8;
        if (ctx.RequestedAt.UtcDateTime.Hour is >= 2 and <= 5) score += 6;
        return ValueTask.FromResult(score);
    }
}

public sealed class MlScoreRule(IFraudScorer scorer, bool enabled) : IFraudRule
{
    public string Name => "ml_score";
    public int Priority => 40;

    public async ValueTask<RuleOutcome> EvaluateAsync(FraudContext ctx, CancellationToken ct)
    {
        if (!enabled) return new RuleOutcome(Name, 0, "model disabled");
        var delta = await scorer.ScoreAsync(ctx, ct);
        return new RuleOutcome(Name, delta, $"model {scorer.ModelVersion} contributed {delta}");
    }
}
