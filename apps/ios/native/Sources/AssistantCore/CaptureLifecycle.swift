// SPDX-License-Identifier: Apache-2.0
import Foundation

/// Capture readiness and bounded route recovery, driven by the native host's generation
/// and monotonic clock. Server acceptance alone never arms a microphone watchdog.
public struct CaptureLifecycle {
    public enum RouteAction:Equatable {case ignore,recover,fail}
    public enum Failure:Equatable {case noRaw,noConversion,stalled}
    private enum Phase {case stopped,preparing,starting,capturing,recovering}
    private var generation:Int?
    private var phase=Phase.stopped
    private var readyAt:TimeInterval?
    private var route=""
    private var recoveryAvailable=true
    public init(){}

    public mutating func begin(generation:Int,recovering:Bool=false){
        guard self.generation.map({generation >= $0}) ?? true else{return}
        self.generation=generation;phase = .preparing;readyAt=nil;route=""
        if !recovering {recoveryAvailable=true}
    }
    public mutating func starting(generation:Int){
        guard self.generation==generation,phase == .preparing else{return}
        phase = .starting
    }
    public mutating func ready(generation:Int,route:String,at:TimeInterval){
        guard self.generation==generation,phase == .starting,at.isFinite else{return}
        self.route=route;readyAt=at;phase = .capturing
    }
    public mutating func stop(generation:Int){
        guard self.generation.map({generation >= $0}) ?? true else{return}
        self.generation=generation;phase = .stopped;readyAt=nil;route=""
        // A route replacement passes through stop. Only a deliberate new begin,
        // or a converted buffer from its ready graph, restores recovery capacity.
    }
    public mutating func captured(generation:Int){
        guard self.generation==generation,phase == .capturing else{return}
        recoveryAvailable=true
    }
    public mutating func routeChange(generation:Int,route:String,engineRunning:Bool)->RouteAction {
        guard self.generation==generation,phase == .capturing else{return .ignore}
        if engineRunning && route==self.route {return .ignore}
        guard recoveryAvailable else{phase = .stopped;readyAt=nil;return .fail}
        recoveryAvailable=false;phase = .recovering;readyAt=nil
        return .recover
    }
    public func failure(generation:Int,now:TimeInterval,lastRaw:TimeInterval?,lastConverted:TimeInterval?)->Failure? {
        guard self.generation==generation,phase == .capturing,let readyAt,
              now.isFinite,now>=readyAt else{return nil}
        func current(_ value:TimeInterval?)->TimeInterval? {
            guard let value,value.isFinite,value>=readyAt,value<=now else{return nil}
            return value
        }
        if let converted=current(lastConverted) {return now-converted>=3 ? .stalled:nil}
        guard now-readyAt>=8 else{return nil}
        return current(lastRaw)==nil ? .noRaw:.noConversion
    }
}
