// SPDX-License-Identifier: Apache-2.0
import Foundation
import AssistantCore

/// A process-local identity, never saved in Keychain, owns the live declaration.
/// Heartbeats carry revision/identity preconditions rather than redeclaring solo.
/// Forced termination needs no callback: the server expires the last heartbeat.
final class NativeAudience {
    enum Failure:LocalizedError {
        case unavailable,unsupported,changed,cancelled
        var errorDescription:String? {
            switch self {
            case .unavailable:return "The private server could not verify this app's live audience session. Reconnect and try again."
            case .unsupported:return "This server does not support app-lifetime audience sessions. Update the private Lifestream server before listening."
            case .changed:return "The audience or session changed. The conversation stopped; reopen or start again after reviewing server permission."
            case .cancelled:return "Audience activation was cancelled."
            }
        }
    }
    private let transport:NativeTransport
    private let now:()->Date
    private var generation=0,transportEpoch=0,pending=false
    private var timer:Timer?,task:URLSessionDataTask?
    private var lease:AudienceConnectionLease?,payload=[String:Any]()
    private var lifecycle=AudienceLifecycle()
    var onEnded:(String)->Void = {_ in}
    var leaseId:String?{guard let lease,lease.expiresAt>now(),transportEpoch==transport.epoch else{return nil};return lease.id}
    init(transport:NativeTransport,now:@escaping()->Date=Date.init){self.transport=transport;self.now=now}
    deinit{timer?.invalidate();task?.cancel()}
    func resignActive(){lifecycle.resignActive()}
    func becomeActive(){lifecycle.becomeActive()}
    func protectedDataUnavailable(){lifecycle.protectedDataUnavailable()}
    func protectedDataAvailable(){if !lifecycle.protectedDataAvailable(){end("Phone unlocked outside the app. Open Lifestream and tap Start to resume.")}}
    func enterBackground(continueWhenLocked:Bool,protectedDataAvailable:Bool){
        if !lifecycle.enterBackground(continueWhenLocked:continueWhenLocked,protectedDataAvailable:protectedDataAvailable){
            end(continueWhenLocked ? "App left the foreground without confirmed lock evidence. Conversation ended.":"App left the foreground. Continue when locked is off; conversation ended.")
        }
    }
    private func decode(_ result:Result<(Data,HTTPURLResponse),Error>) throws->[String:Any]{
        guard case .success(let (bytes,response))=result else{throw Failure.unavailable}
        if response.statusCode==404 || response.statusCode==405{throw Failure.unsupported}
        guard response.statusCode==200,let value=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any] else{throw Failure.changed}
        return value
    }
    private func body(_ operation:String,id:String,revision:Int)->String {
        String(data:try! JSONSerialization.data(withJSONObject:["operation":operation,"leaseId":id,"expectedAudienceRevision":revision]),encoding:.utf8)!
    }
    private func release(_ lease:AudienceConnectionLease,epoch:Int){
        guard transport.epoch==epoch else{return}
        transport.request("/api/runtime/v1/audience/lease",method:"POST",body:body("end",id:lease.id,revision:lease.revision),timeout:1.2){_ in}
    }
    private func accept(_ value:[String:Any],id:String) throws {
        lease=try AudienceConnectionLease(value,expectedId:id,now:now());payload=value
        if timer==nil{let heartbeat=Timer(timeInterval:5,repeats:true){[weak self] _ in self?.heartbeat{_ in}};timer=heartbeat;RunLoop.main.add(heartbeat,forMode:.common)}
    }
    func begin(_ done:@escaping(Result<[String:Any],Error>)->Void){
        guard lifecycle.state == .foreground else{done(.failure(Failure.cancelled));return}
        guard !pending else{done(.failure(Failure.cancelled));return}
        let previous=leaseId
        end("Starting a new app audience session",notify:false,sendRelease:false)
        generation += 1;let ticket=generation,epoch=transport.epoch,id=UUID().uuidString.lowercased();transportEpoch=epoch;pending=true
        task=transport.request("/api/runtime/v1/audience",timeout:1.2){[weak self] result in
            guard let self,self.generation==ticket,self.transport.epoch==epoch else{done(.failure(Failure.cancelled));return}
            do{
                let current=try self.decode(result)
                if let previous,current["leaseId"] as? String==previous,current["privateAllowed"] as? Bool==true {
                    try self.accept(current,id:previous);self.pending=false;self.task=nil;done(.success(current));return
                }
                guard let revision=current["revision"] as? Int,revision>=0 else{throw Failure.unsupported}
                self.task=self.transport.request("/api/runtime/v1/audience/lease",method:"POST",body:self.body("begin",id:id,revision:revision),timeout:1.2){[weak self] response in
                    guard let self else{done(.failure(Failure.cancelled));return}
                    if self.generation != ticket || self.transport.epoch != epoch {
                        if let value=try? self.decode(response),let old=try? AudienceConnectionLease(value,expectedId:id,now:self.now()){self.release(old,epoch:epoch)}
                        done(.failure(Failure.cancelled));return
                    }
                    self.pending=false;self.task=nil
                    do{let value=try self.decode(response);try self.accept(value,id:id);done(.success(value))}
                    catch{self.end(error.localizedDescription);done(.failure(error))}
                }
            }catch{self.pending=false;self.task=nil;self.end(error.localizedDescription);done(.failure(error))}
        }
    }
    func heartbeat(_ done:@escaping(Result<[String:Any],Error>)->Void){
        guard !pending else{done(.failure(Failure.cancelled));return}
        guard let lease,lease.expiresAt>now(),transportEpoch==transport.epoch,lifecycle.state != .ended else{end(Failure.changed.localizedDescription);done(.failure(Failure.changed));return}
        pending=true;let ticket=generation,epoch=transportEpoch
        task=transport.request("/api/runtime/v1/audience/lease",method:"POST",body:body("renew",id:lease.id,revision:lease.revision),timeout:1.2){[weak self] result in
            guard let self,self.generation==ticket,self.transport.epoch==epoch else{done(.failure(Failure.cancelled));return}
            self.pending=false;self.task=nil
            do{let value=try self.decode(result);try self.accept(value,id:lease.id);done(.success(value))}
            catch{self.end(error.localizedDescription);done(.failure(error))}
        }
    }
    func cancelActivation(){if lease==nil&&pending{end("Audience activation cancelled.",notify:false)}}
    func end(_ reason:String,notify:Bool=true,sendRelease:Bool=true,expectedLeaseId:String?=nil){
        if let expectedLeaseId,lease?.id != expectedLeaseId{return}
        let old=lease,epoch=transportEpoch;generation += 1;pending=false;task?.cancel();task=nil;timer?.invalidate();timer=nil;lease=nil;payload=[:]
        if sendRelease,let old{release(old,epoch:epoch)}
        if notify{onEnded(reason)}
    }
}
