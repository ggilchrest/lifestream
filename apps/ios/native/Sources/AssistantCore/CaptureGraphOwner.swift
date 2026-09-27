// SPDX-License-Identifier: Apache-2.0
/// Keeps the audio session's voice-processing graph alive during route reconciliation.
/// Used on the native host's serial control queue; a full Stop releases all resources.
public enum CaptureGraphOwnerError:Error {case cancelled}
public final class CaptureGraphOwner<Graph> {
    private var epoch=0
    public private(set) var current:Graph?
    public init(){}
    public func acquire(_ create:() throws -> Graph) throws -> Graph {
        if let current{return current}
        let ticket=epoch,graph=try create()
        guard ticket==epoch else{throw CaptureGraphOwnerError.cancelled}
        current=graph;return graph
    }
    public func stop(recovering:Bool,stop:(Graph)->Void,deactivate:()->Void){
        epoch += 1
        if let current{stop(current)}
        if !recovering{current=nil;deactivate()}
    }
}
