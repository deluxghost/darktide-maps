import {buildBandGraph} from "../preprocess/floors/graph.mjs";
import {findOcclusion} from "../preprocess/floors/occlusion.mjs";
import {partitionOrderedCut} from "../preprocess/floors/ordered_cut.mjs";
import {compilePartition} from "../preprocess/floors/compile.mjs";
import assert from "node:assert/strict";
import {createFloorSlices} from "../preprocess/floors.mjs";

function surface(height, size=30, steps=30) {
  const positions=[],indices=[];
  for(let y=0;y<=steps;y++)for(let x=0;x<=steps;x++)positions.push(x/steps*size,y/steps*size,height(x/steps*size,y/steps*size));
  for(let y=0;y<steps;y++)for(let x=0;x<steps;x++){
    const a=y*(steps+1)+x,b=a+1,c=a+steps+1,d=c+1;indices.push(a,b,c,b,d,c);
  }
  return {positions:new Float32Array(positions),indices:new Uint32Array(indices)};
}
function stack(gap=6){
  const a=surface(()=>0,20,10),b=surface(()=>gap,20,10),count=a.positions.length/3;
  return {positions:new Float32Array([...a.positions,...b.positions]),indices:new Uint32Array([...a.indices,...Array.from(b.indices,i=>i+count)])};
}
function spiral(){
  const positions=[],indices=[],steps=180;
  for(let i=0;i<=steps;i++){
    const angle=i/steps*Math.PI*6;
    for(const r of [8,12])positions.push(Math.cos(angle)*r,Math.sin(angle)*r,i/steps*18);
    if(i<steps){const a=i*2;indices.push(a,a+1,a+2,a+1,a+3,a+2);}
  }
  return {positions:new Float32Array(positions),indices:new Uint32Array(indices)};
}
const cases=[
  {name:'rough-continuous-ground',mesh:surface((x,y)=>3.5*Math.exp(-((x-15)**2+(y-15)**2)/45)),floors:1},
  {name:'long-planar-slope',mesh:surface(x=>x*.4),floors:1},
  {name:'stacked-disconnected-platforms',mesh:stack(),floors:2},
  {name:'stacked-2-point-2-clearance',mesh:stack(2.2),floors:2},
  {name:'three-turn-spiral',mesh:spiral(),minFloors:3},
];
const report=[];
for(const item of cases){
  const graph=buildBandGraph(item.mesh),overlap=findOcclusion(graph),partition=partitionOrderedCut(graph,overlap),geometry=compilePartition(graph,partition);
  let orderingViolations=0;
  for(const key of overlap.relations.keys()){
    const [a,b]=key.split(':').map(Number);if(partition.labels[a]>=partition.labels[b])orderingViolations++;
  }
  const passed=(item.floors===undefined||geometry.stats.floors===item.floors)&&(item.minFloors===undefined||geometry.stats.floors>=item.minFloors)&&orderingViolations===0&&geometry.stats.areaError<1e-7;
  const result={name:item.name,passed,expectedFloors:item.floors,minFloors:item.minFloors,orderingViolations,...geometry.stats};report.push(result);console.log(JSON.stringify(result));
}
if(report.some(r=>!r.passed))process.exitCode=1;

function addSurface(mesh, extra, offset) {
  const count=mesh.positions.length/3;
  return {positions:new Float32Array([...mesh.positions,...Array.from(extra.positions,(v,i)=>v+offset[i%3])]),indices:new Uint32Array([...mesh.indices,...Array.from(extra.indices,i=>i+count)])};
}
function display(mesh) {
  return createFloorSlices({mission:'synthetic',vertices:Array.from({length:mesh.positions.length/3},(_,i)=>Array.from(mesh.positions.slice(i*3,i*3+3))),triangles:Array.from({length:mesh.indices.length/3},(_,i)=>Array.from(mesh.indices.slice(i*3,i*3+3),v=>v+1))});
}
const tinyRoof=display(addSurface(surface(()=>0,20,10),surface(()=>0,4,2),[2,2,4]));
assert.equal(tinyRoof.manifest.layers.length,1);
assert.equal(tinyRoof.manifest.stats.mergedFloorBoundaries,1);
assert.ok(tinyRoof.manifest.stats.areaError<1e-7);
const satellites=display(addSurface(addSurface(stack(),surface(()=>0,1,1),[20.5,10,6.1]),surface(()=>0,1,1),[20.5,5,0.1]));
assert.equal(satellites.manifest.layers.length,2);
assert.equal(satellites.sampler.floorAt([21,10.5,6.1]),satellites.sampler.floorAt([19,10.5,6]));
assert.equal(satellites.sampler.floorAt([21,5.5,0.1]),satellites.sampler.floorAt([19,5.5,0]));
assert.notEqual(satellites.sampler.floorAt([19,5.5,0]),satellites.sampler.floorAt([19,10.5,6]));
const smallStack=display(addSurface(surface(()=>0,7,1),surface(()=>0,7,1),[0,0,6]));
assert.equal(smallStack.manifest.layers.length,2);
const raisedSatellite=display(addSurface(stack(12),surface(()=>0,2,1),[21,10,16]));
assert.equal(raisedSatellite.sampler.floorAt([22,11,16]),raisedSatellite.sampler.floorAt([19,11,12]));
assert.notEqual(raisedSatellite.sampler.floorAt([22,11,16]),raisedSatellite.sampler.floorAt([19,11,0]));
console.log(JSON.stringify({displayCases:4,tinyRoofFloors:1,satelliteFloors:2,smallStackFloors:2,raisedSatelliteFollowsUpper:true}));
