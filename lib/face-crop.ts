export async function detectFaceCenterX(video:HTMLVideoElement,atTime:number):Promise<number>{
 const originalTime=video.currentTime;
 try{
  video.currentTime=Math.min(video.duration,Math.max(0,atTime));
  await new Promise<void>(resolve=>{video.addEventListener("seeked",()=>resolve(),{once:true});setTimeout(resolve,1600);});
  const canvas=document.createElement("canvas");canvas.width=video.videoWidth;canvas.height=video.videoHeight;
  canvas.getContext("2d")?.drawImage(video,0,0);
  const {FaceDetector,FilesetResolver}=await import("@mediapipe/tasks-vision");
  const vision=await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm");
  const detector=await FaceDetector.createFromOptions(vision,{baseOptions:{modelAssetPath:"https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"},runningMode:"IMAGE"});
  const result=detector.detect(canvas);detector.close();
  const box=result.detections?.[0]?.boundingBox;
  return box?Math.max(0,Math.min(1,(box.originX+box.width/2)/canvas.width)):0.5;
 }catch(e){console.warn("Face detection fallback to center crop",e);return 0.5;}
 finally{video.currentTime=originalTime;}
}
