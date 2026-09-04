# Julia Test Explorer

Julia Test Explorer discovers named Julia `@testset` blocks and integrates them with VS Code's native Testing view.

## Features

- Discovers statically named `Test.@testset` and `@testset` blocks in Julia files anywhere in the workspace.
- Organizes discovered test sets by project and source file.
- Runs individual test sets, files, projects, or every discovered test set.
- Reports queued, running, passed, failed, and errored states.
- Streams Julia output into VS Code's Test Results output.
- Refreshes discovery when saved `.jl` files change.

## Requirements

- VS Code 1.136.0 or newer.
- Julia 1.10 or newer.
- The `julia` executable on `PATH`, unless an explicit path is configured.

The bundled Julia helpers use only Julia standard libraries. A source file uses its nearest ancestor `Project.toml` when one exists; otherwise it runs from the containing workspace folder.

## Install From A VSIX

```bash
npm install
npm run package:vsix
code --install-extension ./julia-test-explorer.vsix --force
```

Reload VS Code after installation. To remove the extension later:

```bash
code --uninstall-extension derekshoneycutt.julia-test-explorer
```

## Use The Extension

1. Open a folder or workspace containing Julia files with named `@testset` blocks.
2. Save modified `.jl` files because discovery operates on files on disk.
3. Open VS Code's Testing view.
4. Run a test set, source file, project, or all tests using the standard test controls.

Selecting a test navigates to its `@testset` declaration. Running an item executes its source file in the nearest Julia project environment, or the workspace environment when no `Project.toml` exists.

## Extension Settings

| Setting | Default | Description |
| --- | --- | --- |
| `juliaTestExplorer.juliaPath` | `julia` | Julia command or absolute executable path. |
| `juliaTestExplorer.testArguments` | `[]` | Additional Julia arguments passed before the runner script. |
| `juliaTestExplorer.exclude` | `**/{.git,node_modules,out,dist}/**` | Glob excluded from Julia file discovery. |

Example:

```json
{
  "juliaTestExplorer.juliaPath": "/opt/julia/bin/julia",
  "juliaTestExplorer.testArguments": ["--check-bounds=yes"]
}
```

## Development

```bash
npm install
npm run compile
npm run test:helper
npm test
```

Press `F5` to compile the extension and open an Extension Development Host.

## Current Scope

- Discovery includes statically named `@testset` blocks in any non-excluded Julia file.
- Dynamically generated test-set names and standalone `@test` expressions are not shown as explorer items.
- A selected item executes its source file; only selected items receive published states.
- Test-only dependencies must be available from the project environment.
- Discovery and execution use saved files only.
- Debugging, coverage, and continuous test runs are not currently supported.