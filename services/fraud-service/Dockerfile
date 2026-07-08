# syntax=docker/dockerfile:1.7
# Build context: repo root (dockerfile: services/fraud-service/Dockerfile)

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY contracts/gen/csharp ./contracts/gen/csharp
COPY services/fraud-service ./services/fraud-service
WORKDIR /src/services/fraud-service
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet restore FraudService/FraudService.csproj && \
    dotnet restore FraudService.Tests/FraudService.Tests.csproj && \
    dotnet test FraudService.Tests/FraudService.Tests.csproj -c Release --no-restore -v minimal && \
    dotnet publish FraudService/FraudService.csproj -c Release --no-restore -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled
WORKDIR /app
COPY --from=build /app .
ENV ASPNETCORE_HTTP_PORTS=""
EXPOSE 8080 9090
ENTRYPOINT ["dotnet", "FraudService.dll"]
