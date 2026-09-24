import {randomUUID} from 'node:crypto';
import type {Database} from '@lifestream/storage-sqlite';
/** Restored channel destinations require fresh owner intent, subscriber pairing
 * and consent. Preserve terminal delivery facts; an attempted send is unknown,
 * never permission to resend. This operates only on the isolated restored DB. */
export function quarantineRestoredChannels(database:Database){
 return database.transaction(tx=>{
  const count=(sql:string)=>Number(tx.get<{n:number}>(sql)!.n),now=Date.now();
  const result={disabledDestinations:count("SELECT count(*) AS n FROM channel_subscriptions WHERE status!='removed' AND (status!='disabled' OR requested_conversations!=0 OR requested_alerts!=0)"),revokedPairings:count("SELECT count(*) AS n FROM telegram_pairings WHERE state!='revoked'"),cancelledReservations:count("SELECT count(*) AS n FROM telegram_deliveries WHERE state='reserved'"),uncertainConversationSends:count("SELECT count(*) AS n FROM telegram_deliveries WHERE state='sending'"),uncertainNoticeSends:count("SELECT count(*) AS n FROM telegram_notice_deliveries WHERE state='sending'")};
  tx.run("UPDATE channel_subscriptions SET status='disabled',requested_conversations=0,requested_alerts=0,revision=revision+1,updated_at=? WHERE status!='removed' AND (status!='disabled' OR requested_conversations!=0 OR requested_alerts!=0)",new Date(now).toISOString());
  tx.run("UPDATE telegram_pairings SET state='revoked',revision=revision+1,challenge_digest=NULL,chat_id=NULL,user_id=NULL,claim_id=NULL,conversations_enabled=0,alerts_enabled=0,updated_at=? WHERE state!='revoked'",now);
  tx.run('DELETE FROM telegram_notice_authority');
  tx.run('UPDATE telegram_poll_state SET generation=?','restore-quarantine:'+randomUUID());
  tx.run("UPDATE telegram_deliveries SET state=CASE WHEN state='sending' THEN 'unknown' ELSE 'cancelled' END,updated_at=? WHERE state IN ('reserved','sending')",now);
  tx.run("UPDATE telegram_notice_deliveries SET state='unknown',updated_at=? WHERE state='sending'",now);
  return result;
 });
}
