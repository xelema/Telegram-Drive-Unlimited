import { describe, expect, it } from 'vitest';
import { cleanupCandidates } from '../../src/services/cleanup';
import type { WorkspaceFile } from '../../src/services/workspace';
const file=(key:string,name:string,size:number,date='2026-09-10'):WorkspaceFile=>({key,id:Number(key),folder_id:null,name,size,sizeStr:'',created_at:date,folderName:'Saved',tags:[],collectionIds:[]});
describe('reviewable cleanup candidates',()=>{
 it('groups possible duplicates without automatically selecting or deleting any file',()=>{
  const files=[file('1','Photo.jpg',10),file('2','photo.JPG',10),file('3','Photo.jpg',12),file('4','Other.jpg',10)];
  expect(cleanupCandidates(files,'duplicates').map(f=>f.key)).toEqual(['1','2']);expect(files).toHaveLength(4);
 });
 it('does not treat unparseable dates as old and orders large files by size',()=>{
  const files=[file('1','old',1,'2020-01-01'),file('2','unknown',200*1024*1024,''),file('3','large',300*1024*1024)];
  expect(cleanupCandidates(files,'old',Date.parse('2026-09-10')).map(f=>f.key)).toEqual(['1']);expect(cleanupCandidates(files,'large').map(f=>f.key)).toEqual(['3','2']);
 });
});
