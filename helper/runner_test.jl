"""Tests for structured execution and reporting through `ExplorerTestSet`."""
module RunnerHelperTests

using Test

include("runner.jl")

@testset "runner" begin
  mktempdir() do directory
    suite_directory = joinpath(directory, "specs")
    mkpath(suite_directory)
    suite_path = joinpath(suite_directory, "arithmetic.jl")
    write(suite_path, """
      using Test
      @testset \"passing\" begin
        @test true
        @testset \"nested\" begin
          @test true
        end
      end
      @testset \"failing\" begin
        @test false
      end
      """)
    report_path = joinpath(directory, "report.json")

    @test run_files(directory, [suite_path], report_path) == 0
    report = read(report_path, String)
    @test contains(report, "\"test_path\":[\"passing\"]")
    @test contains(report, "\"test_path\":[\"passing\",\"nested\"]")
    @test contains(report, "\"status\":\"passed\"")
    @test contains(report, "\"test_path\":[\"failing\"]")
    @test contains(report, "\"status\":\"failed\"")
    @test contains(report, replace(suite_path, "\\" => "\\\\"))
  end
end

end