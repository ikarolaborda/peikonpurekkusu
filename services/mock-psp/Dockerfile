# syntax=docker/dockerfile:1.7
# Build context: repo root (dockerfile: services/mock-psp/Dockerfile)

FROM golang:1.26 AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-p=1
COPY services/mock-psp ./services/mock-psp
WORKDIR /src/services/mock-psp
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download && go vet ./... && \
    go build -trimpath -ldflags="-s -w" -o /out/mock-psp .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/mock-psp /mock-psp
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/mock-psp"]
