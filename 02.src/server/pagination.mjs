export function pageParameters(url){
 const raw=url.searchParams.get('limit')||'20';if(!/^\d+$/.test(raw)||Number(raw)<1||Number(raw)>100)throw new Error('件数は1〜100を指定してください。');
 let cursor=null;const encoded=url.searchParams.get('cursor');
 if(encoded){if(encoded.length>500||!/^[a-zA-Z0-9_-]+$/.test(encoded))throw new Error('ページ指定が不正です。');try{cursor=JSON.parse(Buffer.from(encoded,'base64url').toString());}catch{throw new Error('ページ指定が不正です。');}if(!cursor||typeof cursor.date!=='string'||!Number.isFinite(Date.parse(cursor.date))||typeof cursor.id!=='string'||cursor.id.length>100||!cursor.id.length)throw new Error('ページ指定が不正です。');}
 return {limit:Number(raw),cursor};
}
export const encodeCursor=row=>Buffer.from(JSON.stringify({date:row.date,id:row.id})).toString('base64url');
