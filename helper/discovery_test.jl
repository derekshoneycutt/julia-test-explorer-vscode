"""Tests for parser-based discovery of statically named Julia test sets."""
module DiscoveryHelperTests

using Test

include("discovery.jl")

@testset "discovery" begin
  mktempdir() do directory
    suite_directory = joinpath(directory, "specs")
    mkpath(suite_directory)
    suite_path = joinpath(suite_directory, "arithmetic.jl")
    write(suite_path, """
      using Test
      @testset \"outer\" begin
        @testset \"inner\" begin
          @test true
        end
      end
      Test.@testset \"qualified\" begin
        @test true
      end
      """)

    tests = discover_project(directory, [suite_path])
    @test getfield.(tests, :name) == ["outer", "inner", "qualified"]
    @test tests[2].test_path == ["outer", "inner"]
    @test tests[1].start.line == 2
    @test tests[1].start.column > 0
  end
end

end