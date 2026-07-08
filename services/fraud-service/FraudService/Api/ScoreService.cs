using System.Text.Json;
using Grpc.Core;
using Peikon.Contracts.Fraud.V1;
using Peikon.Fraud.Domain;
using Peikon.Fraud.Infrastructure;

namespace Peikon.Fraud.Api;

/// <summary>
/// Inline pre-authorization scoring. The caller holds a hard deadline
/// (~150 ms) — everything here must be budgeted: Redis calls carry their own
/// timeout with per-rule outage fallbacks, and log persistence is fire-and-
/// forget through the bounded channel writer.
/// </summary>
public sealed class ScoreService(RulePipeline pipeline, IFraudScorer scorer, FraudLogWriter logWriter,
    ILogger<ScoreService> logger) : FraudService.FraudServiceBase
{
    public override async Task<ScoreResponse> Score(ScoreRequest request, ServerCallContext context)
    {
        var ctx = new FraudContext(
            request.PaymentId,
            request.UserId,
            request.AccountId,
            request.AmountMinorUnits,
            request.CurrencyCode,
            request.MerchantId,
            request.PaymentMethod,
            request.CountryCode,
            request.RequestedAtUnixMs > 0
                ? DateTimeOffset.FromUnixTimeMilliseconds(request.RequestedAtUnixMs)
                : DateTimeOffset.UtcNow);

        var result = await pipeline.EvaluateAsync(ctx, context.CancellationToken);

        var logEntry = new FraudLog
        {
            PaymentId = ctx.PaymentId,
            UserId = ctx.UserId,
            Decision = result.Decision.ToString().ToLowerInvariant(),
            RiskScore = result.RiskScore,
            ModelVersion = scorer.ModelVersion,
            FeaturesSnapshot = JsonSerializer.SerializeToDocument(ctx),
            RuleOutcomes = JsonSerializer.SerializeToDocument(result.Outcomes),
        };
        if (!logWriter.TryEnqueue(logEntry))
        {
            logger.LogWarning("fraud log channel full — entry dropped for {PaymentId}", ctx.PaymentId);
        }

        var resp = new ScoreResponse
        {
            Decision = result.Decision switch
            {
                Domain.Decision.Approve => Contracts.Fraud.V1.Decision.Approve,
                Domain.Decision.StepUp => Contracts.Fraud.V1.Decision.StepUp,
                Domain.Decision.Hold => Contracts.Fraud.V1.Decision.Hold,
                _ => Contracts.Fraud.V1.Decision.Deny,
            },
            RiskScore = result.RiskScore,
            ModelVersion = scorer.ModelVersion,
            FraudLogId = logEntry.Id.ToString(),
        };
        resp.Outcomes.AddRange(result.Outcomes.Select(o => new Contracts.Fraud.V1.RuleOutcome
        {
            RuleName = o.RuleName,
            ScoreDelta = o.ScoreDelta,
            Detail = o.Detail,
        }));
        return resp;
    }
}
