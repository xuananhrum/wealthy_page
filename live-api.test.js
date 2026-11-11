'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
test('on-demand provider response groups sale and same-project rent, never mixes projects', async()=>{
 const old=process.env.SCRAPPA_API_KEY;process.env.SCRAPPA_API_KEY='TEST_KEY_NOT_REAL';
 delete require.cache[require.resolve('./server')];const {searchMarket}=require('./server');
 const fetchOld=global.fetch;const calls=[];
 try{
  global.fetch=async url=>{const q=new URL(url);calls.push(q);
   let items;
   if(q.searchParams.get('listing_type')==='sale'){
    items=[{id:1001,title:'Căn A bán 2PN',url:'https://batdongsan.com.vn/a',price:{value_vnd:3000000000},area:63,bedrooms:2,location:{project_id:555,project_name:'Dự án A'}},
    {id:1002,title:'Căn A 2',url:'https://batdongsan.com.vn/b',price:{value_vnd:3200000000},area:65,bedrooms:2,location:{project_id:555,project_name:'Dự án A'}},
    {id:1003,title:'Căn B bán',url:'https://batdongsan.com.vn/c',price:{value_vnd:2500000000},area:60,bedrooms:2,location:{project_id:777,project_name:'Dự án B'}}];
   } else if(q.searchParams.get('location_id')==='555'){
    items=[{id:2001,title:'Thuê A',url:'https://batdongsan.com.vn/rent-a',price:{value_vnd:8000000},area:64,bedrooms:2,location:{project_id:555,project_name:'Dự án A'}},
    {id:2002,title:'Tin khác dự án phải loại',url:'https://batdongsan.com.vn/rent-other',price:{value_vnd:30000000},area:65,bedrooms:2,location:{project_id:999,project_name:'Không phải A'}}];
   } else items=[];
   return {ok:true,status:200,json:async()=>({success:true,data:{items,pagination:{has_next_page:false,total:items.length}}})};
  };
  const v={budget:3,margin:20,bedrooms:2,city:'SG',minArea:45,maxArea:95,minVnd:2400000000,maxVnd:3600000000};
  const got=await searchMarket(v);
  assert.equal(got.projects.length,2);assert.equal(got.sample.saleListings,3);
  const proj=got.projects.find(p=>p.name==='Dự án A');assert.equal(proj.saleMedianBillion,3.1);
  assert.equal(proj.rentCount,1);assert.equal(proj.rentMedianMillion,8);assert.equal(proj.grossYieldPct,3.1);
  assert(calls.some(c=>c.searchParams.get('listing_type')==='sale'&&c.searchParams.get('min_price')==='2400000000'));
  assert(calls.some(c=>c.searchParams.get('listing_type')==='rent'&&c.searchParams.get('location_type')==='project'&&c.searchParams.get('location_id')==='555'));
 }finally{global.fetch=fetchOld;if(old===undefined)delete process.env.SCRAPPA_API_KEY;else process.env.SCRAPPA_API_KEY=old}
});
