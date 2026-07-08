# syntax=docker/dockerfile:1.7
# Build context: repo root (dockerfile: services/audit-service/Dockerfile)

FROM golang:1.26 AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-p=1
COPY services/audit-service ./services/audit-service
WORKDIR /src/services/audit-service
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download && \
    go vet ./... && \
    go test ./... && \
    go build -trimpath -ldflags="-s -w" -o /out/audit-service ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/audit-service /audit-service
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/audit-service"]
