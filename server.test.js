'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const http=require('node:http');
const {validate,median,parseItem,groupSale,handler}=require('./server');

test('budget ±20%, city, size and bedrooms validated',()=>{
 const q=new URLSearchParams('budget=3&margin=20&city=SG&bedrooms=2&minArea=45&maxArea=95');
 const v=validate(q);assert.equal(v.minVnd,2400000000);assert.equal(v.maxVnd,3600000000);
 assert.equal(v.bedrooms,2);assert.equal(v.city,'SG');
 assert.throws(()=>validate(new URLSearchParams('budget=-1')));
 assert.throws(()=>validate(new URLSearchParams('budget=3&city=NY')));
});
test('medians, listing validation, source sanitation',()=>{
 assert.equal(median([2.5,3.1,2.9]),2.9);assert.equal(median([4,3,1,2]),2.5);
 const item=parseItem({id:12,price:{value_vnd:3000000000},area:65,bedrooms:2,url:'javascript:alert(1)',location:{project_id:100,project_name:'A'}} ,'sale');
 assert.equal(item.projectId,100);assert.equal(item.source,null);
 const groups=groupSale([item,{...item,id:'13',priceVnd:3100000000}],3000000000,6);
 assert.equal(groups.length,1);assert.equal(groups[0].sales.length,2);
});
test('unconfigured provider fails transparently without fabricating results',async()=>{
 const server=http.createServer((req,res)=>handler(req,res));await new Promise(resolve=>server.listen(0,resolve));
 try{const root=`http://127.0.0.1:${server.address().port}`;
   const status=await (await fetch(root+'/api/status')).json();assert.equal(status.ready,false);
   const response=await fetch(root+'/api/market-search?budget=3&margin=20&city=SG&bedrooms=2');
   assert.equal(response.status,503);const data=await response.json();assert.equal(data.code,'NOT_CONFIGURED');
   const html=await fetch(root+'/');assert.equal(html.status,200);assert((await html.text()).includes('Tìm tin mới'));
 } finally {server.close()}
});
