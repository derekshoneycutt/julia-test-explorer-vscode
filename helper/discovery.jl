"""Version of the JSON discovery protocol shared with the extension."""
const PROTOCOL_VERSION = 1

"""A one-based line and column in a Julia source file."""
struct SourcePosition
  line::Int
  column::Int
end

"""Metadata for a statically named `@testset` discovered in one source file."""
struct DiscoveredTest
  project_path::String
  name::String
  test_path::Vector{String}
  file_path::String
  start::SourcePosition
  stop::SourcePosition
end

"""
  json_string(value::AbstractString)::String

Encode `value` as a JSON string without requiring a package dependency.
"""
function json_string(value::AbstractString)::String
  escaped = replace(value, '\\' => "\\\\", '"' => "\\\"", '\n' => "\\n", '\r' => "\\r", '\t' => "\\t")
  return "\"$(escaped)\""
end

"""Encode a discovered test using the extension's versioned JSON schema."""
function test_json(test::DiscoveredTest)::String
  path = join(json_string.(test.test_path), ",")
  return "{" *
    "\"project_path\":" * json_string(test.project_path) * "," *
    "\"name\":" * json_string(test.name) * "," *
    "\"test_path\":[" * path * "]," *
    "\"file_path\":" * json_string(test.file_path) * "," *
    "\"start\":{\"line\":$(test.start.line),\"column\":$(test.start.column)}," *
    "\"end\":{\"line\":$(test.stop.line),\"column\":$(test.stop.column)}" *
    "}"
end

"""
  macro_name(expression::Expr)::Union{Symbol, Nothing}

Return the called macro's symbol for plain, global, and module-qualified calls.
"""
function macro_name(expression::Expr)::Union{Symbol, Nothing}
  expression.head == :macrocall || return nothing
  name = expression.args[1]
  if name isa Symbol
    return name
  elseif name isa GlobalRef
    return name.name
  elseif name isa Expr && name.head == :. && last(name.args) isa QuoteNode
    qualified_name = last(name.args)::QuoteNode
    return qualified_name.value isa Symbol ? qualified_name.value : nothing
  end
  return nothing
end

"""Return the literal name of a statically named `@testset`, or `nothing`."""
function testset_name(expression::Expr)::Union{String, Nothing}
  macro_name(expression) == Symbol("@testset") || return nothing
  for argument in expression.args[3:end]
    argument isa String && return argument
  end
  return nothing
end

"""Return an expression's source line, falling back to its parent's line."""
function expression_line(expression::Expr, fallback::Int)::Int
  for argument in expression.args
    argument isa LineNumberNode && return argument.line
  end
  return fallback
end

"""Find the one-based column of `@testset`, returning one when unavailable."""
function macro_column(lines::Vector{String}, line::Int)::Int
  line > length(lines) && return 1
  location = findfirst("@testset", lines[line])
  return isnothing(location) ? 1 : first(location)
end

"""
  discover_expression!(tests, expression, project_path, file_path, lines, ancestry, inherited_line)

Walk an expression tree depth-first and append statically named test sets to
`tests`. `ancestry` tracks nested test-set names, while `inherited_line` carries
source context through expression nodes that lack a `LineNumberNode`.
"""
function discover_expression!(
  tests::Vector{DiscoveredTest},
  expression,
  project_path::String,
  file_path::String,
  lines::Vector{String},
  ancestry::Vector{String},
  inherited_line::Int,
)::Nothing
  expression isa Expr || return nothing
  line = expression_line(expression, inherited_line)
  name = testset_name(expression)
  next_ancestry = ancestry
  if !isnothing(name)
    next_ancestry = [ancestry; name]
    column = macro_column(lines, line)
    push!(tests, DiscoveredTest(
      project_path,
      name,
      next_ancestry,
      file_path,
      SourcePosition(line, column),
      SourcePosition(line, column + length("@testset")),
    ))
  end

  for argument in expression.args
    discover_expression!(tests, argument, project_path, file_path, lines, next_ancestry, line)
  end
  return nothing
end

"""Return Julia source files beneath `project_path`, excluding generated trees."""
function julia_files(project_path::AbstractString)::Vector{String}
  files = String[]
  for (directory, directories, names) in walkdir(project_path)
    filter!(name -> name ∉ (".git", "node_modules", "out", "dist", ".vscode-test"), directories)
    for name in sort(names)
      endswith(name, ".jl") && push!(files, joinpath(directory, name))
    end
  end
  return files
end

"""
  discover_project(project_path, file_paths=julia_files(project_path))

Parse `file_paths` and return their statically named test sets. `project_path`
identifies the workspace or Julia environment that owns the discovered files;
files do not need to reside in a conventional `test` directory.
"""
function discover_project(
  project_path::AbstractString,
  file_paths::AbstractVector{<:AbstractString}=julia_files(project_path),
)::Vector{DiscoveredTest}
  absolute_project = abspath(project_path)
  tests = DiscoveredTest[]
  for candidate in sort(file_paths)
    file_path = abspath(candidate)
    source = read(file_path, String)
    syntax = Meta.parseall(source; filename=file_path)
    discover_expression!(tests, syntax, absolute_project, file_path, String.(split(source, '\n')), String[], 1)
  end
  return tests
end

"""
  main(arguments::Vector{String})::Int

Run discovery for `<project-path> [file.jl ...]`, write versioned JSON to
standard output, and return zero. Return two when the project path is missing.
"""
function main(arguments::Vector{String})::Int
  isempty(arguments) && return 2
  files = length(arguments) == 1 ? julia_files(arguments[1]) : arguments[2:end]
  tests = discover_project(arguments[1], files)
  println("{\"version\":$(PROTOCOL_VERSION),\"tests\":[", join(test_json.(tests), ","), "]}")
  return 0
end

if abspath(PROGRAM_FILE) == @__FILE__
  exit(main(ARGS))
end