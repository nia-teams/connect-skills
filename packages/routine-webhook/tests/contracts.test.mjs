import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
const exec = promisify(execFile);
const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');
async function files(dir) {
  const entries=await readdir(new URL(dir,root),{withFileTypes:true});
  return (await Promise.all(entries.filter(e=>!['.git','node_modules'].includes(e.name)).map(e=>e.isDirectory()?files(`${dir}${e.name}/`):`${dir}${e.name}`))).flat();
}
function crc32(buffer) {
  let crc=0xffffffff;
  for(const byte of buffer){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
test('public identity hygiene and four-layer documentation contract',async()=>{
  const forbidden=new RegExp(['bai'+'chuan','bc'+'-inner','internal'+'.nia-teams','nia.teams'+'.bc'].map(s=>s.replaceAll('.','\\.')).join('|'),'i');
  for(const file of await files('')) {
    if(file.endsWith('.png'))continue;
    assert.ok(!forbidden.test(await read(file)),`Public identity hygiene: ${file}`);
  }
  assert.ok(!(await readdir(root)).includes('scripts'), 'Maintainer capture scaffolding is not public source');
  const assetNotes=await read('docs/assets/README.md');
  assert.ok(!assetNotes.includes('WEB_UI_ROOT'));
  assert.ok(!assetNotes.includes('scripts/'));
  const specification=await read('docs/SPECIFICATION.md');
  assert.match(specification,/omits `source.return`/);
  assert.match(specification,/`403` with error code `no_secret`/);
  const skill=await read('skills/routine-webhook/SKILL.md');
  assert.match(skill,/^---\nname: routine-webhook\ndescription: [^\n]+\n---\n/);
  assert.ok(skill.split('\n').length>=30&&skill.split('\n').length<=86);
  assert.ok((await read('AGENTS.md')).split('\n').length<70);
  for(const doc of ['README.md','README_CN.md','AGENTS.md','docs/SPECIFICATION.md'])assert.ok(!(await read(doc)).startsWith('---'),doc);
  for(const doc of ['README.md','README_CN.md']){
    const text=await read(doc);assert.ok(text.startsWith('# @nia-teams/routine-webhook\n'));
    const first=text.split('\n').slice(0,14).join('\n');
    for(const item of ['npm install @nia-teams/routine-webhook','npx @nia-teams/routine-webhook init','./skills/routine-webhook/SKILL.md','node_modules/@nia-teams/routine-webhook/skills/routine-webhook/SKILL.md'])assert.ok(first.includes(item),`${doc}: ${item}`);
    assert.equal((text.match(/!\[[^\]]*\]\(\.\/docs\/assets\/[^)]+\.png\)/g)||[]).length,2);
    const blocks=[...text.matchAll(/```ts\n([\s\S]*?)```/g)].map(m=>m[1]);
    assert.deepEqual(blocks,[await read('examples/send.ts'),await read('examples/listen.ts')]);
    assert.ok(!/^title:/m.test(text));
  }
  for(const doc of ['README.md','README_CN.md','skills/routine-webhook/SKILL.md','docs/SPECIFICATION.md']) {
    const text=await read(doc);
    for(const term of ['followers = [yourself]','connectMac: true','--no-connect-mac']) assert.ok(text.includes(term),`${doc}: ${term}`);
  }
  for(const doc of ['README.md','skills/routine-webhook/SKILL.md','docs/SPECIFICATION.md']) assert.doesNotMatch(await read(doc),/\p{Script=Han}/u,`${doc}: English only`);
  for(const doc of ['README.md','README_CN.md']) {
    const text=await read(doc);
    for(const word of ['无'+'缝','绝'+'不','一'+'律','严'+'格','精'+'确','完'+'整','确'+'保','自'+'动','直'+'接']) assert.ok(!text.includes(word),`${doc}: Prose: ${word}`);
  }
  for(const doc of ['README.md','README_CN.md','skills/routine-webhook/SKILL.md']) {
    const text=await read(doc);
    for(const term of ['--return none',"return: { type: 'none' }"]) assert.ok(text.includes(term),`${doc}: one-way dispatch: ${term}`);
  }
  for(const doc of ['README.md','README_CN.md','skills/routine-webhook/SKILL.md','AGENTS.md','docs/SPECIFICATION.md']) assert.doesNotMatch(await read(doc),/^title:/m,`${doc}: no preview frontmatter`);
  const declaration=await read('dist/index.d.ts');assert.ok(declaration.includes('skills/routine-webhook/SKILL.md'));assert.ok(declaration.includes('docs/SPECIFICATION.md'));
});

test('two real product PNGs have valid chunks, CRCs, scanlines and even Retina dimensions',async()=>{
  for(const file of ['agent-connect.png','routine-topic-chat.png']){
    const data=await readFile(new URL(`docs/assets/${file}`,root));assert.equal(data.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    let offset=8,width,height,bitDepth,colorType;const idat=[];let ended=false;
    while(offset<data.length){
      const length=data.readUInt32BE(offset),type=data.subarray(offset+4,offset+8).toString();assert.ok(offset+12+length<=data.length);
      const chunk=data.subarray(offset+8,offset+8+length);
      assert.equal(crc32(data.subarray(offset+4,offset+8+length)),data.readUInt32BE(offset+8+length),`${file} ${type} CRC`);
      if(type==='IHDR'){width=chunk.readUInt32BE(0);height=chunk.readUInt32BE(4);bitDepth=chunk[8];colorType=chunk[9];assert.equal(chunk[12],0);}
      if(type==='IDAT')idat.push(chunk);if(type==='IEND')ended=true;offset+=length+12;
    }
    assert.ok(ended);assert.equal(width,2200);assert.equal(height,1560);assert.equal(width%2,0);assert.equal(height%2,0);assert.ok(width>=1600);
    assert.equal(bitDepth,8);assert.ok([2,6].includes(colorType));const pixels=inflateSync(Buffer.concat(idat));assert.equal(pixels.length,height*(1+width*(colorType===2?3:4)));
    assert.ok(new Set(pixels).size>100,'Not a blank placeholder');
  }
});

test('manifest and npm pack dry-run include public docs, skill, examples, binary and declarations',async()=>{
  const p=JSON.parse(await read('package.json'));assert.equal(p.name,'@nia-teams/routine-webhook');assert.equal(p.version,'0.1.0');assert.deepEqual(p.repository,{type:'git',url:'https://github.com/nia-teams/connect-skills.git',directory:'packages/routine-webhook'});assert.equal(p.homepage,'https://github.com/nia-teams/connect-skills/tree/main/packages/routine-webhook#readme');assert.equal(p.type,'module');assert.equal(p.engines.node,'>=20');assert.equal(p.license,'MIT');assert.deepEqual(Object.keys(p.dependencies),['ws']);assert.equal(p.bin['nia-routine-webhook'],'bin/nia-routine-webhook.mjs');
  const {stdout}=await exec('npm',['pack','--dry-run','--json','--ignore-scripts'],{cwd:root.pathname,maxBuffer:8*1024*1024});
  const list=JSON.parse(stdout)[0].files.map(f=>f.path);
  for(const file of ['package.json','README.md','README_CN.md','LICENSE','AGENTS.md','bin/nia-routine-webhook.mjs','skills/routine-webhook/SKILL.md','docs/SPECIFICATION.md','docs/assets/agent-connect.png','docs/assets/routine-topic-chat.png','examples/send.ts','examples/listen.ts','examples/oidc.ts','examples/verify-callback.ts','dist/index.js','dist/index.d.ts'])assert.ok(list.includes(file),file);
  assert.ok(!list.some(f=>f.includes('node_modules')||f.includes('credentials.json')||f.startsWith('tests/')||f.startsWith('scripts/')));
});

 test('monorepo skill and specification match their authoritative root files byte-for-byte', async () => {
  for (const file of ['skills/routine-webhook/SKILL.md', 'docs/SPECIFICATION.md']) {
    assert.deepEqual(await readFile(new URL(file, root)), await readFile(new URL(`../../${file}`, root)), file);
  }
});
