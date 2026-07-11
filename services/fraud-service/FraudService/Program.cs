using Confluent.Kafka;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.EntityFrameworkCore;
using Peikon.Fraud.Api;
using Peikon.Fraud.Domain;
using Peikon.Fraud.Infrastructure;
using StackExchange.Redis;

// `fraud-service healthcheck` — self-probe for the chiseled image (no shell).
if (args.Length > 0 && args[0] == "healthcheck")
{
    using var probe = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
    try
    {
        var res = await probe.GetAsync("http://localhost:8080/health/ready");
        return res.IsSuccessStatusCode ? 0 : 1;
    }
    catch
    {
        return 1;
    }
}

var builder = WebApplication.CreateBuilder(args);

string Env(string key, string fallback) => builder.Configuration[key] ?? fallback;

var dbConn = $"Host={Env("FRAUD_DB_HOST", "fraud-db")};Port={Env("FRAUD_DB_PORT", "5432")};" +
             $"Username={Env("FRAUD_DB_USER", "")};Password={Env("FRAUD_DB_PASSWORD", "")};" +
             $"Database={Env("FRAUD_DB_NAME", "")}";
var redisConn = $"{Env("REDIS_CACHE_HOST", "redis-cache")}:{Env("REDIS_CACHE_PORT", "6379")}," +
                $"password={Env("REDIS_CACHE_PASSWORD", "")},abortConnect=false";

// HTTP/1.1 health+REST on :8080, h2c gRPC on :9090
builder.WebHost.ConfigureKestrel(kestrel =>
{
    kestrel.ListenAnyIP(8080, o => o.Protocols = HttpProtocols.Http1);
    kestrel.ListenAnyIP(9090, o => o.Protocols = HttpProtocols.Http2);
});

builder.Services.AddGrpc();
builder.Services.AddDbContext<FraudDbContext>(o => o.UseNpgsql(dbConn));
builder.Services.AddSingleton<IConnectionMultiplexer>(_ => ConnectionMultiplexer.Connect(redisConn));
builder.Services.AddSingleton<IVelocityStore>(sp => new VelocityStore(
    sp.GetRequiredService<IConnectionMultiplexer>(),
    TimeSpan.FromMilliseconds(int.Parse(Env("FRAUD_REDIS_BUDGET_MS", "20")))));

var outagePolicy = new OutagePolicy(long.Parse(Env("FRAUD_FAIL_CLOSED_THRESHOLD", "5000")));
var mlEnabled = Env("FRAUD_ML_ENABLED", "false") == "true";
builder.Services.AddSingleton(outagePolicy);
builder.Services.AddSingleton<IFraudScorer, HeuristicScorer>();
builder.Services.AddSingleton<IFraudRule>(sp => new DenylistRule(sp.GetRequiredService<IVelocityStore>()));
builder.Services.AddSingleton<IFraudRule>(sp => new VelocityCountRule(sp.GetRequiredService<IVelocityStore>(), outagePolicy));
builder.Services.AddSingleton<IFraudRule>(sp => new VelocityAmountRule(sp.GetRequiredService<IVelocityStore>(), outagePolicy));
builder.Services.AddSingleton<IFraudRule>(_ => new AmountTierRule());
builder.Services.AddSingleton<IFraudRule>(sp => new GeoMismatchRule(sp.GetRequiredService<IVelocityStore>()));
builder.Services.AddSingleton<IFraudRule>(sp => new MlScoreRule(sp.GetRequiredService<IFraudScorer>(), mlEnabled));
builder.Services.AddSingleton(new DecisionPolicy(
    int.Parse(Env("FRAUD_STEP_UP_AT", "60")),
    int.Parse(Env("FRAUD_HOLD_AT", "75")),
    int.Parse(Env("FRAUD_DENY_AT", "90"))));
builder.Services.AddSingleton<RulePipeline>();

builder.Services.AddSingleton<IProducer<string, byte[]>>(_ =>
    new ProducerBuilder<string, byte[]>(new ProducerConfig
    {
        BootstrapServers = Env("KAFKA_BOOTSTRAP_SERVERS", "kafka:19092"),
        EnableIdempotence = true,
        Acks = Acks.All,
    }).Build());
builder.Services.AddSingleton(sp => new EventsCodec(
    new HttpClient(),
    Env("SCHEMA_REGISTRY_URL", "http://apicurio-registry:8080/apis/ccompat/v7")));

builder.Services.AddSingleton<FraudLogWriter>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<FraudLogWriter>());
builder.Services.AddHostedService<OutboxRelay>();
builder.Services.AddHostedService<DeepAnalysisConsumer>();

builder.Services.AddHealthChecks()
    .AddNpgSql(dbConn, tags: ["ready"]);

var app = builder.Build();

// Dev/demo schema management (documented deviation: production uses EF
// migration bundles; single-replica compose is safe with EnsureCreated).
await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<FraudDbContext>();
    await db.Database.EnsureCreatedAsync();
}

app.MapGrpcService<ScoreService>();
app.MapHealthChecks("/health/ready", new Microsoft.AspNetCore.Diagnostics.HealthChecks.HealthCheckOptions
{
    Predicate = c => c.Tags.Contains("ready"),
});
app.MapGet("/health/live", () => Results.Ok(new { status = "ok" }));

app.Run();
return 0;
