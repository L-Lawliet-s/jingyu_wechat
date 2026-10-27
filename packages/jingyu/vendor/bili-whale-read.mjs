// Adapted from Alterssss/dsh-bili-whale, commit 8b0009f8ce2ebdc421afcb2e727b19ac18912ec6.
// Copyright (c) 2026 ALTERSSSS. MIT; see bili-whale-LICENSE.txt.
// Changes: expose read-only pure functions; remove CLI, home-directory access,
// credentials, polling and all social write operations.
import crypto from 'node:crypto';
const MIXIN=[46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const keyOf=url=>String(url).split('/').at(-1).split('.')[0];
export function signWbi(params,images,now=Date.now()){
 const raw=keyOf(images?.img_url??'')+keyOf(images?.sub_url??'');if(raw.length!==64)throw Error('WBI 签名密钥缺失');
 const key=MIXIN.map(i=>raw[i]).join('').slice(0,32),values={...params,wts:Math.floor(now/1000)};delete values.w_rid;
 const query=Object.keys(values).sort().map(k=>encodeURIComponent(k)+'='+encodeURIComponent(String(values[k]).replace(/[!'()*]/g,''))).join('&');return query+'&w_rid='+crypto.createHash('md5').update(query+key).digest('hex');
}
export const commentRecord=(row,max=400)=>({rpid:String(row.rpid??''),user:String(row.member?.uname??'匿名'),like:Number(row.like??0),replies:Number(row.rcount??0),at:Number(row.ctime??0),text:String(row.content?.message??'').replace(/\s+/g,' ').trim().slice(0,max)});
