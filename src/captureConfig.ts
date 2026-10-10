export type CaptureMode = "live" | "video" | "offline";

type CaptureSettings = {
  mode:CaptureMode;mic:string;output:string;micTranscription:boolean;
  sttMode:"local"|"api";sttEngine:string;sttModel:string;sttApiProvider:string;
};

/** Keep the question source distinct from optional candidate transcription. */
export function capturePartyConfigs(settings:CaptureSettings) {
  const offline=settings.mode==="offline";
  const transcribeReply=settings.mode==="live" && settings.micTranscription;
  const provider=settings.sttMode==="local" ? settings.sttEngine : settings.sttApiProvider;
  const model=settings.sttMode==="local" ? settings.sttModel : null;
  return {
    you:{role:"You",device_id:settings.mic,is_input_device:true,
      stt_provider:offline ? "disabled" : transcribeReply ? provider : "web_speech",
      local_model_id:transcribeReply ? model : null},
    them:{role:"Them",device_id:offline ? settings.mic : settings.output,is_input_device:offline,
      stt_provider:provider,local_model_id:model},
  };
}
