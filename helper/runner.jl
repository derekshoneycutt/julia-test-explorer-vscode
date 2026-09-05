using Test

"""Version of the JSON result protocol shared with the extension."""
const REPORT_VERSION = 1
"""Internal test-set name used to install the custom collector."""
const ROOT_TESTSET = "__julia_test_explorer_root__"
"""Absolute source paths eligible for runtime source attribution."""
const active_test_files = Set{String}()
"""Non-root test sets completed during the current helper invocation."""
const completed_testsets = Any[]

"""A `Test.AbstractTestSet` that captures nested results for JSON reporting."""
mutable struct ExplorerTestSet <: Test.AbstractTestSet
  description::String
  test_path::Vector{String}
  results::Vector{Any}
  file_path::String
  line::Int
  started_ns::UInt64
  duration_ms::Float64
  is_root::Bool
end

"""
  source_location()::Tuple{String, Int}

Return the first stack frame belonging to an active test file. Julia's
`@testset` expansion does not pass its source location to custom constructors,
so this is best-effort attribution; result matching uses file and test path
rather than this line number.
"""
function source_location()::Tuple{String, Int}
  for frame in stacktrace()
    file_path = abspath(String(frame.file))
    if file_path in active_test_files
      return (file_path, frame.line)
    end
  end
  return ("", 1)
end

"""Construct a collector and derive its nested test path from the active parent."""
function ExplorerTestSet(description; kwargs...)
  text = string(description)
  is_root = text == ROOT_TESTSET
  parent = Test.get_testset_depth() == 0 ? nothing : Test.get_testset()
  parent_path = parent isa ExplorerTestSet ? parent.test_path : String[]
  test_path = is_root ? String[] : [parent_path; text]
  file_path, line = source_location()
  return ExplorerTestSet(text, test_path, Any[], file_path, line, time_ns(), 0.0, is_root)
end

"""Record a result or child test set in `testset`."""
function Test.record(testset::ExplorerTestSet, result)
  push!(testset.results, result)
  return result
end

"""Reduce nested Julia results to `passed`, `failed`, or `errored`."""
function result_status(results::Vector{Any})::Symbol
  status = :passed
  for result in results
    child_status = if result isa ExplorerTestSet
      result_status(result.results)
    elseif result isa Test.Error
      :errored
    elseif result isa Test.Fail
      :failed
    else
      :passed
    end
    child_status == :errored && return :errored
    child_status == :failed && (status = :failed)
  end
  return status
end

"""Collect printable failure and error details from nested Julia results."""
function failure_message(results::Vector{Any})::String
  messages = String[]
  for result in results
    if result isa ExplorerTestSet
      message = failure_message(result.results)
      isempty(message) || push!(messages, message)
    elseif result isa Test.Fail || result isa Test.Error
      push!(messages, sprint(show, result))
    end
  end
  return join(messages, "\n")
end

"""Finalize timing, publish the test set, and attach it to its active parent."""
function Test.finish(testset::ExplorerTestSet)
  testset.duration_ms = (time_ns() - testset.started_ns) / 1_000_000
  testset.is_root || push!(completed_testsets, testset)
  if !testset.is_root && Test.get_testset_depth() != 0
    Test.record(Test.get_testset(), testset)
  end
  return testset
end

"""
  json_string(value::AbstractString)::String

Encode `value` as a JSON string without requiring a package dependency.
"""
function json_string(value::AbstractString)::String
  escaped = replace(value, '\\' => "\\\\", '"' => "\\\"", '\n' => "\\n", '\r' => "\\r", '\t' => "\\t")
  return "\"$(escaped)\""
end

"""Encode one completed test set using the extension's result schema."""
function report_json(testset::ExplorerTestSet)::String
  path = join(json_string.(testset.test_path), ",")
  return "{" *
    "\"file_path\":" * json_string(testset.file_path) * "," *
    "\"line\":$(testset.line)," *
    "\"test_path\":[" * path * "]," *
    "\"status\":" * json_string(string(result_status(testset.results))) * "," *
    "\"message\":" * json_string(failure_message(testset.results)) * "," *
    "\"duration_ms\":$(testset.duration_ms)" *
    "}"
end

"""
  run_entrypoint(project_path, working_directory, execution_path, active_file_paths, report_path)::Int

Execute one suite entrypoint inside `working_directory` with `ExplorerTestSet`
active, then write a versioned JSON report to `report_path`. `active_file_paths`
identifies selected source files for runtime attribution. Top-level load errors
are captured in the report so the helper can still return a readable result.
"""
function run_entrypoint(
  _project_path::AbstractString,
  working_directory::AbstractString,
  execution_path::AbstractString,
  active_file_paths::AbstractVector{<:AbstractString},
  report_path::AbstractString,
)::Int
  empty!(active_test_files)
  union!(active_test_files, abspath.(active_file_paths))
  empty!(completed_testsets)
  root_error = ""

  try
    cd(abspath(working_directory)) do
      @testset ExplorerTestSet "$ROOT_TESTSET" begin
        Base.include(Main, abspath(execution_path))
      end
    end
  catch error
    root_error = sprint(showerror, error, catch_backtrace())
  end

  reports = join(report_json.(completed_testsets), ",")
  open(report_path, "w") do output
    print(output, "{\"version\":$(REPORT_VERSION),\"tests\":[", reports,
      "],\"error\":", json_string(root_error), "}")
  end
  return 0
end

"""
  main(arguments::Vector{String})::Int

Run `<project-path> <working-directory> <report-path> <execution-path>
<active-file.jl>...`. Return two when any required argument is missing;
otherwise return the result of `run_entrypoint`.
"""
function main(arguments::Vector{String})::Int
  length(arguments) >= 5 || return 2
  return run_entrypoint(arguments[1], arguments[2], arguments[4], arguments[5:end], arguments[3])
end

if abspath(PROGRAM_FILE) == (@__FILE__) && (@__MODULE__) === Main
  exit(main(ARGS))
end