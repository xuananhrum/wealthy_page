'use strict';
/**
 * WealthLab live market bridge. Requires SCRAPPA_API_KEY server-side.
 * Listings are publicly advertised ASKING prices, not closed transactions.
 * Built-in short-lived cache and rudimentary IP throttling guard API spend.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {URL} = require('node:url');
const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(__dirname);
const HOST = process.env.HOST || '0.0.0.0';
const API_BASE = 'https://scrappa.co/api/batdongsan/search';
const KEY = process.env.SCRAPPA_API_KEY || '';
const CACHE_TTL_MS = 15 * 60 * 1000;
// Conservative application-side limits. In-process counters reset on deploy/restart;
// for high-traffic production, use persistent quotas and authenticated access.
const MAX_PROVIDER_REQUESTS_PER_DAY = Math.max(8, Math.min(5000, Number(process.env.SCRAPPA_MAX_CALLS_PER_DAY || 100)));
let providerCallDay = '';
let providerCallsToday = 0;
const pending = new Map();
const cache = new Map();
const buckets = new Map();
const YEAR_MS = 365 * 86400 * 1000;
const round = (v,d=2) => Math.round(v*10**d)/10**d;
function median(numbers) {
  const a=numbers.filter(Number.isFinite).sort((x,y)=>x-y);
  return a.length===0 ? null : a.length%2===1 ? a[(a.length-1)/2] : (a[a.length/2-1]+a[a.length/2])/2;
}
function legalURL(v) {
  try { const u = new URL(v); return u.protocol==='https:' && (u.hostname === 'batdongsan.com.vn' || u.hostname.endsWith('.batdongsan.com.vn')) ? u.toString() : null; }
  catch{return null}
}
function parseItem(item,type) {
  if(!item||typeof item!=='object'||item.is_expired===true) return null;
  const rawPrice=Number(item.price?.value_vnd),area=Number(item.area);
  if(!Number.isFinite(rawPrice)||rawPrice<=0) return null;
  if(type==='sale' && (rawPrice<100000000 || rawPrice>1e12))return null;
  if(type==='rent' && (rawPrice<100000 || rawPrice>150000000))return null;
  const location=item.location||{}, id=String(item.id || '').replace(/[^\d]/g,'');
  const projectId=Number(location.project_id || item.project_id)||null;
  const projectName=String(location.project_name || item.project_name || '').trim().slice(0,120);
  const source=legalURL(item.url);
  const updatedRaw=item.last_up_time||item.updated_at||item.date_updated||null;
  let updatedAt=null;
  if(updatedRaw && !Number.isNaN(new Date(updatedRaw).getTime())) updatedAt=new Date(updatedRaw).toISOString();
  return {id,projectId,projectName, priceVnd:rawPrice, area:Number.isFinite(area) && area>8&&area<500?area:null,
    bedrooms:Number.isFinite(+item.bedrooms)&&+item.bedrooms>0?+item.bedrooms:null,
    title:String(item.title||'Tin bất động sản').trim().slice(0,180),
    source,updatedAt,listedAgeDays:updatedAt?Math.floor((Date.now()-Date.parse(updatedAt))/86400000):null,
    verified:item.verified?.is_verified===true};
}
function consumeProviderQuota(){
  const day=new Date().toISOString().slice(0,10);
  if(day!==providerCallDay){providerCallDay=day;providerCallsToday=0}
  if(providerCallsToday>=MAX_PROVIDER_REQUESTS_PER_DAY){
    throw Object.assign(new Error('Đã đạt giới hạn truy vấn nguồn dữ liệu hôm nay. Vui lòng thử lại ngày mai hoặc tăng hạn mức quản trị.'),{status:429,code:'PROVIDER_DAILY_CAP'});
  }
  providerCallsToday++;
}
async function upstream(params) {
  consumeProviderQuota();
  const qs=new URLSearchParams(params);const u=API_BASE+'?'+qs;
  const response=await fetch(u,{headers:{'x-api-key':KEY,'accept':'application/json'},signal:AbortSignal.timeout(30000)});
  if(!response.ok){
    if(response.status===401 || response.status===403){
      throw Object.assign(new Error('Khóa API Scrappa chưa hợp lệ hoặc không có quyền truy cập. Kiểm tra SCRAPPA_API_KEY trên Render.'),{status:503,code:'INVALID_API_KEY'});
    }
    if(response.status===429){
      throw Object.assign(new Error('Nhà cung cấp đã giới hạn số lượt API; thử lại sau.'),{status:503,code:'PROVIDER_RATE_LIMIT'});
    }
    const err=new Error('Nguồn dữ liệu tạm lỗi ('+response.status+').');err.status=502;err.code='PROVIDER_ERROR';throw err
  }
  const obj=await response.json();
  if(obj.success===false||!Array.isArray(obj.data?.items)){
    const err=new Error('Dữ liệu bên thứ ba không đúng định dạng hoặc đang bị gián đoạn.');err.status=502;throw err;
  }
  return obj.data;
}
function unique(items){const used=new Set();return items.filter(x=>{const id=x.id || x.source || x.title+'_'+x.priceVnd;if(used.has(id))return false;used.add(id);return true})}
function groupSale(items, budget, maxGroups) {
  const groups=new Map();
  for(const x of unique(items)) {
    if(!x.projectId || !x.projectName)continue;
    const k=String(x.projectId);if(!groups.has(k))groups.set(k, {id:k,name:x.projectName,sales:[],rents:[]});
    groups.get(k).sales.push(x);
  }
  return [...groups.values()].map(g=>{
    g.medianSale=median(g.sales.map(x=>x.priceVnd));g.medianArea=median(g.sales.map(x=>x.area));
    g.distance=Math.abs(g.medianSale - budget);return g;
  }).sort((a,b)=>b.sales.length-a.sales.length||a.distance-b.distance).slice(0,maxGroups);
}
function validate(q){
  const budget=Number(q.get('budget'));
  const margin=Number(q.get('margin') ?? 20);
  const bedrooms=Number(q.get('bedrooms') ?? 2);
  const city=q.get('city')||'SG';
  const minArea=Number(q.get('minArea')??45),maxArea=Number(q.get('maxArea')??95);
  const allowedCities=['SG','HN','BD','DNA','DDN','CT'];
  if(!Number.isFinite(budget)||budget<1||budget>15)throw Object.assign(new Error('Ngân sách phải từ 1 đến 15 tỷ đồng.'),{status:400});
  if(!Number.isFinite(margin)||margin<5||margin>40)throw Object.assign(new Error('Biên độ tìm kiếm phải từ 5% đến 40%.'),{status:400});
  if(!Number.isInteger(bedrooms)||bedrooms<1||bedrooms>4)throw Object.assign(new Error('Chọn từ 1 đến 4 phòng ngủ.'),{status:400});
  if(!allowedCities.includes(city))throw Object.assign(new Error('Khu vực không hợp lệ.'),{status:400});
  if(!Number.isFinite(minArea)||!Number.isFinite(maxArea)||minArea<20||maxArea>250||maxArea<=minArea)throw Object.assign(new Error('Khoảng diện tích phải nằm trong 20–250 m².'),{status:400});
  return {budget,margin,bedrooms,city,minArea,maxArea,minVnd:Math.round(budget*1e9*(1-margin/100)),maxVnd:Math.round(budget*1e9*(1+margin/100))};
}
async function searchMarket(v){
  const common={city:v.city,bedrooms:String(v.bedrooms),min_area:String(v.minArea),max_area:String(v.maxArea),per_page:'75',sort:'default'};
  const first=await upstream({...common,listing_type:'sale',category:'324',min_price:String(v.minVnd),max_price:String(v.maxVnd),page:'1'});
  let all=first.items;
  if(first.pagination?.has_next_page===true){
    const second=await upstream({...common,listing_type:'sale',category:'324',min_price:String(v.minVnd),max_price:String(v.maxVnd),page:'2'});
    all=all.concat(second.items);
  }
  const sales=unique(all.map(x=>parseItem(x,'sale')).filter(Boolean))
    .filter(x=>x.priceVnd>=v.minVnd&&x.priceVnd<=v.maxVnd&&(!x.bedrooms||x.bedrooms===v.bedrooms));
  const groups=groupSale(sales,v.budget*1e9,6);
  const rentsResults=await Promise.allSettled(groups.map(g=>{
    const med=g.medianArea;const areaLow=Math.max(v.minArea,med?Math.floor(med*.8):v.minArea);
    const areaHigh=Math.min(v.maxArea,med?Math.ceil(med*1.2):v.maxArea);
    const params={city:v.city,listing_type:'rent',category:'326',bedrooms:String(v.bedrooms),location_type:'project',location_id:g.id,
      min_area:String(areaLow<=areaHigh?areaLow:v.minArea),max_area:String(areaLow<=areaHigh?areaHigh:v.maxArea),per_page:'60',page:'1',sort:'default'};
    return upstream(params);
  }));
  for(let i=0;i<groups.length;i++){
    const answer=rentsResults[i];const g=groups[i];
    g.rentLookupFailed=answer.status!=='fulfilled';
    if(g.rentLookupFailed)continue;
    g.rents=unique(answer.value.items.map(x=>parseItem(x,'rent')).filter(Boolean))
      .filter(x=>x.projectId===+g.id && (!x.bedrooms||x.bedrooms===v.bedrooms));
  }
  return {source:'Scrappa / Batdongsan public asking listings (independent, not official)',
    fetchedAt:new Date().toISOString(),filters:{city:v.city,bedrooms:v.bedrooms,budget:v.budget,margin:v.margin,
      minPriceBillion:round(v.minVnd/1e9),maxPriceBillion:round(v.maxVnd/1e9),minArea:v.minArea,maxArea:v.maxArea},
    sample:{saleListings:sales.length,providerTotalSale:Number(first.pagination?.total)||null,
      pagesSearched:first.pagination?.has_next_page===true?2:1,groupsWithRent:groups.filter(g=>g.rents.length>0).length},
    projects:groups.map(g=>{
      const saleMedian=median(g.sales.map(x=>x.priceVnd));const rentMedian=median(g.rents.map(x=>x.priceVnd));
      return {id:g.id,name:g.name,saleCount:g.sales.length,rentCount:g.rents.length,
        saleMedianBillion:round(saleMedian/1e9,3),rentMedianMillion:rentMedian===null?null:round(rentMedian/1e6,2),
        areaMedian:g.medianArea===null?null:round(g.medianArea,1),
        grossYieldPct:rentMedian===null?null:round(rentMedian*12/saleMedian*100,2),
        rentConfidence:g.rentLookupFailed?'nguồn thuê tạm lỗi':g.rents.length>=5?'≥5 mẫu':g.rents.length>=3?'3–4 mẫu':g.rents.length>0?'1–2 mẫu':'chưa có mẫu',
        rentLookupFailed:!!g.rentLookupFailed,
        sales:g.sales.slice(0,5),rents:g.rents.slice(0,4)};
    }),notes:["Chỉ là tin chào bán/cho thuê, không phải giá giao dịch công chứng hoặc hợp đồng thuê đã ký.",
      "Giá trung vị của các tin được lấy mẫu, không đại diện cho toàn bộ thị trường.",
      "Không có dữ liệu thuê cùng dự án thì không ước lượng lợi suất.",
      "Thời gian cập nhật tin phụ thuộc nguồn đăng, không bảo đảm trạng thái căn còn bán/thuê."]};
}
function send(res,status,obj){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(obj))}
function rateLimit(ip){const now=Date.now();const vals=(buckets.get(ip)||[]).filter(t=>now-t<600000);if(vals.length>=12)return true;vals.push(now);buckets.set(ip,vals);return false}
async function handler(req,res){
  if(req.method!=='GET')return send(res,405,{error:'Chỉ hỗ trợ GET.'});
  let reqURL;try{reqURL=new URL(req.url,'http://localhost')}catch{return send(res,400,{error:'URL không hợp lệ.'})}
  if(reqURL.pathname==='/api/status')return send(res,200,{ready:Boolean(KEY),verified:false,provider:'Scrappa',ttlMinutes:15,quotaPerDay:MAX_PROVIDER_REQUESTS_PER_DAY});
  if(reqURL.pathname==='/api/market-search'){
    if(!KEY)return send(res,503,{error:'Chưa kết nối nguồn dữ liệu. Cần cấu hình SCRAPPA_API_KEY trên máy chủ để bật tìm kiếm trực tiếp.',code:'NOT_CONFIGURED'});
    let v;try{v=validate(reqURL.searchParams)}catch(e){return send(res,e.status||400,{error:e.message})}
    const cacheKey=JSON.stringify(v),hit=cache.get(cacheKey);
    if(hit && hit.until>Date.now())return send(res,200,{...hit.value,cacheHit:true});
    const ip=String(req.socket.remoteAddress||'unknown').slice(0,80);
    if(rateLimit(ip))return send(res,429,{error:'Anh đã tìm quá nhiều lần trong 10 phút. Thử lại sau để tránh phát sinh chi phí API.'});
    // Concurrent identical requests share one upstream operation and cache result.
    let work=pending.get(cacheKey);
    if(!work){
      work=searchMarket(v).then(result=>{
        cache.set(cacheKey,{until:Date.now()+CACHE_TTL_MS,value:result});
        if(cache.size>120){for(const [k,val] of cache.entries()){if(val.until<Date.now())cache.delete(k)}while(cache.size>120)cache.delete(cache.keys().next().value)}
        return result;
      }).finally(()=>pending.delete(cacheKey));
      pending.set(cacheKey,work);
    }
    try{return send(res,200,await work)}catch(e){
      console.error('[market]',e.code||e.status||'provider_error');
      return send(res,e.status||502,{error:e.message||'Không tìm thấy dữ liệu lúc này.',code:e.code||'PROVIDER_ERROR'});
    }
  }
  const name=reqURL.pathname==='/'?'/index.html':reqURL.pathname;
  const safe=['/index.html','/favicon.ico'];if(!safe.includes(name))return send(res,404,{error:'Not found'});
  if(name==='/favicon.ico'){res.writeHead(204);return res.end()}
  fs.readFile(path.join(ROOT,'index.html'),(err,data)=>{if(err)return send(res,500,{error:'Không mở được giao diện.'});res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; base-uri 'self'; object-src 'none'"});res.end(data)})
}
if(require.main===module){http.createServer((req,res)=>{Promise.resolve(handler(req,res)).catch(e=>send(res,500,{error:'Lỗi máy chủ.'}))}).listen(PORT,HOST,()=>console.log('WealthLab v4 listening on :'+PORT+(KEY?' (live provider connected)':' (provider not configured)')))}
module.exports={handler,validate,median,parseItem,groupSale,searchMarket};
