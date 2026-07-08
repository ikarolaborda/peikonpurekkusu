namespace Peikon.Fraud.Domain;

/// <summary>Input snapshot a rule evaluates against (all money in minor units).</summary>
public sealed record FraudContext(
    string PaymentId,
    string UserId,
    string AccountId,
    long AmountMinorUnits,
    string CurrencyCode,
    string MerchantId,
    string PaymentMethod,
    string CountryCode,
    DateTimeOffset RequestedAt);

/// <summary>What a single rule contributed.</summary>
public sealed record RuleOutcome(string RuleName, int ScoreDelta, string Detail, bool HardDeny = false);

/// <summary>
/// One link in the scoring chain (Chain of Responsibility). Rules are ordered
/// by <see cref="Priority"/> and the pipeline short-circuits when a rule
/// returns <c>HardDeny</c>.
/// </summary>
public interface IFraudRule
{
    string Name { get; }
    int Priority { get; }
    ValueTask<RuleOutcome> EvaluateAsync(FraudContext ctx, CancellationToken ct);
}
