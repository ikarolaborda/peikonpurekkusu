using Peikon.Fraud.Domain;
using Peikon.Fraud.Infrastructure;
using Xunit;

namespace Peikon.Fraud.Tests;

file sealed class StubRule(string name, int priority, RuleOutcome outcome, Action? onEvaluate = null) : IFraudRule
{
    public string Name => name;
    public int Priority => priority;

    public ValueTask<RuleOutcome> EvaluateAsync(FraudContext ctx, CancellationToken ct)
    {
        onEvaluate?.Invoke();
        return ValueTask.FromResult(outcome);
    }
}

public class RulePipelineTests
{
    private static FraudContext Ctx(long amount = 1000) => new(
        "p1", "u1", "a1", amount, "USD", "m-books", "card", "PT", DateTimeOffset.UtcNow);

    [Fact]
    public async Task Rules_run_in_priority_order_and_scores_accumulate()
    {
        var order = new List<string>();
        var pipeline = new RulePipeline(
        [
            new StubRule("second", 20, new("second", 30, ""), () => order.Add("second")),
            new StubRule("first", 10, new("first", 20, ""), () => order.Add("first")),
        ], new DecisionPolicy());

        var result = await pipeline.EvaluateAsync(Ctx(), CancellationToken.None);

        Assert.Equal(["first", "second"], order);
        Assert.Equal(50, result.RiskScore);
        Assert.Equal(Decision.Approve, result.Decision);
    }

    [Fact]
    public async Task Hard_deny_short_circuits_remaining_rules()
    {
        var laterRan = false;
        var pipeline = new RulePipeline(
        [
            new StubRule("deny", 10, new("deny", 100, "listed", HardDeny: true)),
            new StubRule("later", 20, new("later", 0, ""), () => laterRan = true),
        ], new DecisionPolicy());

        var result = await pipeline.EvaluateAsync(Ctx(), CancellationToken.None);

        Assert.Equal(Decision.Deny, result.Decision);
        Assert.False(laterRan, "rules after a hard deny must not run");
        Assert.Single(result.Outcomes);
    }

    [Theory]
    [InlineData(0, Decision.Approve)]
    [InlineData(59, Decision.Approve)]
    [InlineData(60, Decision.StepUp)]
    [InlineData(75, Decision.Hold)]
    [InlineData(90, Decision.Deny)]
    public async Task Decision_thresholds_map_scores(int score, Decision expected)
    {
        var pipeline = new RulePipeline(
            [new StubRule("only", 1, new("only", score, ""))],
            new DecisionPolicy());
        var result = await pipeline.EvaluateAsync(Ctx(), CancellationToken.None);
        Assert.Equal(expected, result.Decision);
    }

    [Fact]
    public async Task Score_clamps_to_0_100()
    {
        var pipeline = new RulePipeline(
        [
            new StubRule("a", 1, new("a", 80, "")),
            new StubRule("b", 2, new("b", 80, "")),
        ], new DecisionPolicy());
        var result = await pipeline.EvaluateAsync(Ctx(), CancellationToken.None);
        Assert.Equal(100, result.RiskScore);
    }
}

file sealed class StubVelocityStore(bool? denylisted) : IVelocityStore
{
    public Task<(long Count, long AmountSum)?> RecordAndCountAsync(string accountId, string paymentId,
        long amountMinorUnits, DateTimeOffset eventTime, TimeSpan window, CancellationToken ct) =>
        Task.FromResult<(long, long)?>(null);

    public Task<bool?> IsDenylistedAsync(string userId, CancellationToken ct) =>
        Task.FromResult(denylisted);

    public Task<string[]?> RecentCountriesAsync(string userId, string currentCountry, CancellationToken ct) =>
        Task.FromResult<string[]?>(null);
}

public class DenylistRuleTests
{
    private static FraudContext Ctx(long amount) => new(
        "p1", "u1", "a1", amount, "USD", "m-books", "card", "PT", DateTimeOffset.UtcNow);

    [Theory]
    [InlineData(1)]      // a small amount must not buy a free pass
    [InlineData(4999)]   // just under the generic fail-open threshold
    [InlineData(500_000)]
    public async Task Unreadable_denylist_forces_step_up_at_any_amount(long amount)
    {
        var rule = new DenylistRule(new StubVelocityStore(denylisted: null));

        var outcome = await rule.EvaluateAsync(Ctx(amount), CancellationToken.None);

        Assert.True(outcome.ScoreDelta >= 60,
            "an unreadable denylist cannot clear a user — it must force step-up, never approve");
    }

    [Fact]
    public async Task Listed_user_is_hard_denied()
    {
        var rule = new DenylistRule(new StubVelocityStore(denylisted: true));
        var outcome = await rule.EvaluateAsync(Ctx(1000), CancellationToken.None);
        Assert.True(outcome.HardDeny);
    }

    [Fact]
    public async Task Cleared_user_scores_zero()
    {
        var rule = new DenylistRule(new StubVelocityStore(denylisted: false));
        var outcome = await rule.EvaluateAsync(Ctx(1000), CancellationToken.None);
        Assert.Equal(0, outcome.ScoreDelta);
        Assert.False(outcome.HardDeny);
    }
}

public class OutagePolicyTests
{
    [Fact]
    public void Small_amounts_fail_open_with_flag()
    {
        var policy = new OutagePolicy(5000);
        var ctx = new FraudContext("p", "u", "a", 4999, "USD", "m", "card", "", DateTimeOffset.UtcNow);
        var outcome = policy.OnUnavailable("velocity_count", ctx);
        Assert.True(outcome.ScoreDelta < 60, "fail-open must not force a step-up");
        Assert.False(outcome.HardDeny);
    }

    [Fact]
    public void Large_amounts_fail_closed_toward_step_up()
    {
        var policy = new OutagePolicy(5000);
        var ctx = new FraudContext("p", "u", "a", 5000, "USD", "m", "card", "", DateTimeOffset.UtcNow);
        var outcome = policy.OnUnavailable("velocity_count", ctx);
        Assert.True(outcome.ScoreDelta >= 60, "fail-closed must push the score into step-up territory");
    }
}
