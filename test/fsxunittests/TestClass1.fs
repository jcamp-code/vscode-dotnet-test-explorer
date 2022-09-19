module FSharpTests

open Xunit
open Shouldly

[<Fact>]
let ``This is a test that has spaces in it's name`` () =
   (true).ShouldBe(true)

[<Fact>]
let ``Fail``() =
   (true).ShouldBe(false)

[<Fact(Skip = "skipped")>]
let ``SkippedTest``() =
   (true).ShouldBe(false)