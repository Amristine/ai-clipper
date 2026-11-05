export type NativeExportProgress = { progress:number; phase:string; encoder?:string; updatedAt:number };
const jobs = new Map<string, NativeExportProgress>();
export function setNativeExportProgress(jobId:string, value:Partial<NativeExportProgress>){
 if(!jobId)return;
 jobs.set(jobId,{progress:0,phase:"Preparing",updatedAt:Date.now(),...(jobs.get(jobId)||{}),...value});
}
export function getNativeExportProgress(jobId:string){return jobs.get(jobId)||null;}
export function deleteNativeExportProgress(jobId:string){jobs.delete(jobId);}
