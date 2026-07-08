namespace Peikon.Fraud.Domain;

public enum Decision
{
    Approve,
    StepUp,
    Hold,
    Deny,
}

public sealed record PipelineResult(Decision Decision, int RiskScore, IReadOnlyList<RuleOutcome> Outcomes);

/// <summary>
/// Decision thresholds (env-tunable). Score accumulates across rules;
/// a hard deny short-circuits regardless of score.
/// </summary>
public sealed record DecisionPolicy(int StepUpAt = 60, int HoldAt = 75, int DenyAt = 90)
{
    public Decision Map(int score) => score switch
    {
        var s when s >= DenyAt => Decision.Deny,
        var s when s >= HoldAt => Decision.Hold,
        var s when s >= StepUpAt => Decision.StepUp,
        _ => Decision.Approve,
    };
}

/// <summary>
/// The scoring chain: rules run in Priority order, contributions accumulate,
/// a HardDeny stops evaluation immediately (Chain of Responsibility).
/// </summary>
public sealed class RulePipeline(IEnumerable<IFraudRule> rules, DecisionPolicy policy)
{
    private readonly IReadOnlyList<IFraudRule> _rules = rules.OrderBy(r => r.Priority).ToList();

    public async ValueTask<PipelineResult> EvaluateAsync(FraudContext ctx, CancellationToken ct)
    {
        var outcomes = new List<RuleOutcome>(_rules.Count);
        var score = 0;
        foreach (var rule in _rules)
        {
            var outcome = await rule.EvaluateAsync(ctx, ct);
            outcomes.Add(outcome);
            score += outcome.ScoreDelta;
            if (outcome.HardDeny)
            {
                return new PipelineResult(Decision.Deny, Math.Max(score, 100), outcomes);
            }
        }
        return new PipelineResult(policy.Map(Math.Clamp(score, 0, 100)), Math.Clamp(score, 0, 100), outcomes);
    }
}
