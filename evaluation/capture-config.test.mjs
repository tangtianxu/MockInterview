import {test} from 'node:test';
import assert from 'node:assert/strict';
import {capturePartyConfigs} from '../src/captureConfig.ts';

const base={mode:'live',mic:'default',output:'speakers',micTranscription:true,
 sttMode:'local',sttEngine:'sherpa_bilingual',sttModel:'paraformer-zh-en',sttApiProvider:'deepgram'};

test('offline default and named mics enter the question channel with exactly one STT provider',()=>{
 for(const mic of ['default','my-headset'])for(const micTranscription of [true,false]){
  const {you,them}=capturePartyConfigs({...base,mode:'offline',mic,micTranscription});
  assert.equal(them.role,'Them');assert.equal(them.device_id,mic);assert.equal(them.is_input_device,true);
  assert.equal(them.stt_provider,'sherpa_bilingual');assert.equal(them.local_model_id,'paraformer-zh-en');
  assert.equal(you.device_id,mic);assert.equal(you.is_input_device,true);
  assert.equal(you.stt_provider,'disabled');assert.equal(you.local_model_id,null);
 }
});

test('offline speech APIs only receive one microphone stream, never an output device',()=>{
 for(const sttApiProvider of ['deepgram','groq_whisper']){
  const {you,them}=capturePartyConfigs({...base,mode:'offline',sttMode:'api',sttApiProvider});
  assert.equal(you.stt_provider,'disabled');assert.equal(them.stt_provider,sttApiProvider);
  assert.equal(them.device_id,'default');assert.equal(them.is_input_device,true);
  assert.equal(them.local_model_id,null);
 }
});

test('remote and video modes retain output capture and optional candidate context',()=>{
 for(const mode of ['live','video'])for(const micTranscription of [true,false]){
  const {you,them}=capturePartyConfigs({...base,mode,micTranscription});
  assert.equal(them.device_id,'speakers');assert.equal(them.is_input_device,false);
  assert.equal(them.stt_provider,'sherpa_bilingual');
  assert.equal(you.stt_provider,mode==='live'&&micTranscription?'sherpa_bilingual':'web_speech');
  assert.equal(you.local_model_id,mode==='live'&&micTranscription?'paraformer-zh-en':null);
 }
 const api=capturePartyConfigs({...base,sttMode:'api',sttApiProvider:'groq_whisper'});
 assert.equal(api.you.stt_provider,'groq_whisper');assert.equal(api.you.local_model_id,null);
 assert.equal(api.them.stt_provider,'groq_whisper');assert.equal(api.them.local_model_id,null);
});
