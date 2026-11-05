import Foundation
let origin=URL(string:readLine()!)!,mode=CommandLine.arguments[1],scope=HealthOriginalControlJournal.Scope(serverDigest:String(repeating:"a",count:64),principal:UUID(),endpoint:UUID(),session:UUID()),context=MobileControlFixtureHost.Context(scope:scope,transportEpoch:1,contextRevision:1,ordinarySelf:true)
var checks=0
func current()->MobileControlFixtureHost.Context? {checks+=1;if mode=="stale" && checks>1{return .init(scope:scope,transportEpoch:1,contextRevision:2,ordinarySelf:true)};return context}
let body=Data("{\"operation\":\"control\"}".utf8)
if mode=="badOrigin" {do{_ = try MobileControlFixtureLoopback(origin:URL(string:"http://192.0.2.1:5000")!,headers:[:],current:current);exit(2)}catch{print("origin denied");exit(0)}}
if mode=="badHeader" {do{_ = try MobileControlFixtureLoopback(origin:origin,headers:["cookie":"bad\nvalue"],current:current);exit(3)}catch{print("header denied");exit(0)}}
let adapter=try MobileControlFixtureLoopback(origin:origin,headers:["cookie":"fixture-cookie","x-lifestream-csrf":"fixture-csrf","x-lifestream-user-context":"fixture-context"],current:current)
if mode=="stale" {do{_ = try adapter.exchange(body,expected:context);exit(4)}catch{print("stale denied");exit(0)}}
let result=try adapter.exchange(body,expected:context);if mode=="ok" {guard result.status==200,result.body==Data("fixture-response".utf8) else{exit(5)}} else if mode=="denied" {guard result.status==403 else{exit(6)}} else if mode=="redirect" {guard result.status==302 else{exit(7)}} else{exit(8)}
print("raw response passed")
