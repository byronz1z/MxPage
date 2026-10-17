// Curate the user-supplied boards into individual visual references, not product inputs.
import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
const source = process.argv[2];
if (!source) throw new Error('Provide the directory containing the supplied reference images.');
const items = [
  ['vivid-lime', 'd0489fad-5f35-43b1-af77-db471795c4be', [0,0,1,1]],
  ['airy-yellow', '8caa275d-1ee3-4927-bdba-8c167af5e8da', [0,0,1,.73]],
  ['cool-sculpture', '7100f766-72a5-4275-910c-8302ad845582', [0,0,1,.85]],
  ['cobalt-campaign', '34711bc4-9a4c-4cd4-8c81-2fabd12bfca4', [.04,.02,.93,.82]],
  ['dark-editorial', '0c35f511-6c64-4481-91ef-31520b21b24d', [.027,0,.218,.212]],
  ['cocoa-food', 'b4e18a0a-aff0-41ca-8873-a0f4ebb9f50b', [.07,.046,.244,.27]],
  ['sage-glass', '9068e7f9-ec95-4c1f-aa8d-39bca19acc59', [.118,.037,.228,.215]],
  ['aqua-tactile', '9cfe97ef-019f-40b9-ad19-2a9f392f1993', [.028,.231,.20,.266]],
  ['navy-premium', '8ec7980e-ee40-4825-9779-75447e69ff60', [.03,.234,.227,.193]],
  ['olive-editorial', '2c6e15c8-9195-46d5-92ae-1a02e2b9bc03', [0,0,1,.94]],
  ['mineral-set', 'a0543c3d-b189-417c-859f-a3ae368cdf2b', [0,0,1,.94]],
];
const output = path.resolve('public/ecommerce-references');
await fs.mkdir(output, {recursive:true});
for (const [id, file, crop] of items) {
  const input = path.join(source, `codex-clipboard-${file}.png`);
  const {width, height} = await sharp(input).metadata();
  const [x,y,w,h] = crop;
  await sharp(input).extract({left:Math.floor(width*x),top:Math.floor(height*y),width:Math.floor(width*w),height:Math.floor(height*h)}).resize({width:1280,height:1600,fit:'inside',withoutEnlargement:true}).jpeg({quality:88}).toFile(path.join(output, `${id}.jpg`));
  console.log(id);
}
