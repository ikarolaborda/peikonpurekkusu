// Package audit exposes build-time assets embedded from the module root
// (go:embed patterns are relative to the file that declares them).
package audit

import "embed"

//go:embed migrations/*.sql
var MigrationsFS embed.FS
