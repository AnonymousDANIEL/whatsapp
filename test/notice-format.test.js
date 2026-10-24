'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),format=require('../public/notice-format');
test('Notice plain text remains compatible and a literal format prefix round-trips',()=>{
 const plain='欢迎 <img src=x onerror=alert(1)> 0.57';
 assert.equal(format.encode('  '+plain+'  '),plain);assert.deepEqual(format.decode(plain),{text:plain,highlights:[]});
 const literal='MYWASAP_NOTICE_V1:'+JSON.stringify({v:1,text:'literal JSON',highlights:[]});
 assert.deepEqual(format.decode(format.encode(literal)),{text:literal,highlights:[]});
 assert.deepEqual(format.decode('MYWASAP_NOTICE_V1:{broken'),{text:'MYWASAP_NOTICE_V1:{broken',highlights:[]});
});
test('Notice highlights retain Unicode text while sorting, merging and trimming offsets',()=>{
 const source=' \n价格 😀 0.57 \n',price=source.indexOf('0.57'),emoji=source.indexOf('😀');
 const decoded=format.decode(format.encode(source,[[price,price+4],[emoji,emoji+2],[price,price+2]]));
 const text=source.trim();assert.deepEqual(decoded,{text,highlights:[[text.indexOf('😀'),text.indexOf('😀')+2],[text.indexOf('0.57'),text.length]]});
});
test('Formatted CRLF text uses native textarea line endings without shifting emphasis',()=>{
 const text='Rate\r\n😀 0.57\r\nNext',at=text.indexOf('0.57');
 const result=format.decode(format.encode(text,[[at,at+4]]));
 assert.equal(result.text,'Rate\n😀 0.57\nNext');assert.deepEqual(result.highlights,[[result.text.indexOf('0.57'),result.text.indexOf('0.57')+4]]);
 assert.equal(format.encode('A\r\nB'),'A\r\nB','Unformatted legacy content is preserved');
});
test('Notice ranges reject malformed, excessive and split-surrogate selections',()=>{
 const text='A😀B';for(const ranges of [null,'bad',[[0,0]],[[1.5,2]],[[0,5]],[[-1,2]],[[1,2]],[[2,3]],Array.from({length:129},()=>[0,1])])assert.throws(()=>format.encode(text,ranges),RangeError);
 const invalid='MYWASAP_NOTICE_V1:'+JSON.stringify({v:1,text,highlights:[[2,3]]});assert.equal(format.decode(invalid).text,invalid);
});
test('Notice storage retains the existing limit and never silently truncates format or text',()=>{
 const text='x'.repeat(6000);assert.equal(format.encode(text),text);assert.throws(()=>format.encode(text,[[0,1]]),RangeError);
 const large='x'.repeat(5700),stored=format.encode(large,[[1,4],[30,40]]);assert.ok(stored.length<=6000);assert.equal(format.decode(stored).text,large);
});
test('Owner emphasis toggles and partial removal split selections without changing text',()=>{
 const text='EXCLUSIVE RATE: 0.57',start=text.indexOf('0.57'),end=text.length;
 const first=format.highlight(text,[],start,end);assert.equal(format.highlighted(text,first,start,end),true);
 const split=format.highlight(text,first,start+1,end-1,false);assert.deepEqual(split,[[start,start+1],[end-1,end]]);
 assert.deepEqual(format.highlight(text,split,start,end),first);assert.deepEqual(format.highlight(text,first,start,end,false),[]);
});
test('Editing shifts surviving emphasis, extends inner typing and drops removed text',()=>{
 assert.deepEqual(format.rebase('Rate 0.57','New Rate 0.57',[[5,9]]),[[9,13]]);
 assert.deepEqual(format.rebase('Rate 0.57','Rate 0.X57',[[5,9]]),[[5,10]]);
 assert.deepEqual(format.rebase('Rate 0.57','Rate free',[[5,9]]),[]);
 assert.deepEqual(format.rebase('A😀B 0.57','A😎B 0.57',[[5,9]]),[[5,9]]);
});
test('Notice segments preserve literal HTML-like text, newlines and exact original content',()=>{
 const text='<script>alert(1)</script>\nRate 0.57',start=text.indexOf('0.57'),parts=format.parts(text,[[start,text.length]]);
 assert.equal(parts.map(x=>x.text).join(''),text);assert.deepEqual(parts.filter(x=>x.highlight),[{text:'0.57',highlight:true}]);
 assert.equal(parts[0].text,'<script>alert(1)</script>\nRate ');
});
