import { verifiedAssistantSender } from '../dsh-social-bridge-plugin/assistant-policy.mjs';
import { actorChat, hash } from './store.mjs';
import { parseTripMessage } from './trip.mjs';

export async function handleTripMessage(message,{account,allowed,service,send,current,tone=()=>null,now=Date.now}) {
  if(message.platform!=='wechat'||message.kind!=='private'||message.message_type!=='text'||
      message.outgoing||message.forwardedRecord||message.quoteReply||message.interaction||message.files?.length||message.images?.length) return false;
  const request=parseTripMessage(message.text);
  if(!request)return false;
  const actor=verifiedAssistantSender(message);
  const at=Number(message.timestamp)*1000;
  if(!actor||!allowed(message.conversation_id)||!current()||!message.message_id||
      !Number.isFinite(at)||Math.abs(now()-at)>5*60_000) return true;
  const chat=actorChat(actor);
  const receipt=hash(JSON.stringify([account,chat,String(message.message_id),'trip-v1']));
  let reply, host;
  try {
    host=service();
    reply=host.chat(request,{actor,chat,name:message.sender_name,receipt});
  } catch(error) {
    reply=error.status?error.message:'活动暂时没处理好，请稍后发一条新消息重试。';
  }
  if(!reply||!current()||!allowed(message.conversation_id))return true;
  const owner=host?.store.owner(chat,actor)===true;
  let card;
  try { card=host?tone(host.store,chat)?.card:null; } catch {}
  const address=owner?(card?.address||'主人'):'';
  const text=(address?address+'，':'')+(card?.style==='playful'?'叮～':'')+reply;
  await send({kind:'private',target:message.conversation_id,text,deliveryId:receipt});
  return true;
}
