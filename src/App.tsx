/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { Upload, Image as ImageIcon, Loader2, CheckCircle2, Download, ArrowRight, Languages, AlertCircle, RefreshCw, KeyRound } from 'lucide-react';
import { translateImage } from './lib/gemini';
import { createExtractorFromData } from 'node-unrar-js';
import wasmUrl from 'node-unrar-js/esm/js/unrar.wasm?url';

declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

type AppState = 'UPLOAD' | 'GENERATING_PREVIEW' | 'PREVIEW' | 'PROCESSING_BULK' | 'DONE';

interface ImageFile {
  name: string;
  base64: string;
  mimeType: string;
}

interface TranslatedPreview {
  pt: string;
  fr: string;
  en: string;
}

interface TranslatedFile {
  fileName: string;
  base64: string;
}

function uint8ArrayToBase64(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

export default function App() {
  const [apiKeySelected, setApiKeySelected] = useState<boolean>(true);
  const [appState, setAppState] = useState<AppState>('UPLOAD');
  const [images, setImages] = useState<ImageFile[]>([]);
  const [previewOriginal, setPreviewOriginal] = useState<ImageFile | null>(null);
  const [previewTranslated, setPreviewTranslated] = useState<TranslatedPreview | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, label: '' });
  const [resultZip, setResultZip] = useState<Blob | null>(null);
  const [translatedFiles, setTranslatedFiles] = useState<TranslatedFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const checkApiKey = async () => {
      if (window.aistudio && window.aistudio.hasSelectedApiKey) {
        const hasKey = await window.aistudio.hasSelectedApiKey();
        setApiKeySelected(hasKey);
      }
    };
    checkApiKey();
  }, []);

  const handleSelectKey = async () => {
    if (window.aistudio && window.aistudio.openSelectKey) {
      await window.aistudio.openSelectKey();
      setApiKeySelected(true); // Assume success to mitigate race condition
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setAppState('GENERATING_PREVIEW');
    setTranslatedFiles([]);
    setResultZip(null);
    
    try {
      const extractedImages: ImageFile[] = [];
      const fileName = file.name.toLowerCase();

      if (fileName.endsWith('.zip')) {
        const zip = new JSZip();
        const loadedZip = await zip.loadAsync(file);
        
        for (const [filename, zipEntry] of Object.entries(loadedZip.files)) {
          if (!zipEntry.dir && filename.match(/\.(png|jpe?g)$/i)) {
            const base64 = await zipEntry.async('base64');
            const ext = filename.split('.').pop()?.toLowerCase();
            const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
            
            extractedImages.push({
              name: filename,
              base64,
              mimeType
            });
          }
        }
      } else if (fileName.endsWith('.rar')) {
        const response = await fetch(wasmUrl);
        const wasmBinary = await response.arrayBuffer();
        const fileData = await file.arrayBuffer();
        
        const extractor = await createExtractorFromData({ data: fileData, wasmBinary });
        const list = extractor.getFileList();
        const fileHeaders = [...list.fileHeaders];
        
        const extracted = extractor.extract({ files: fileHeaders.map(h => h.name) });
        const files = [...extracted.files];
        
        for (const f of files) {
          if (!f.fileHeader.flags.directory && f.fileHeader.name.match(/\.(png|jpe?g)$/i)) {
            if (f.extraction) {
              const base64 = uint8ArrayToBase64(f.extraction);
              const ext = f.fileHeader.name.split('.').pop()?.toLowerCase();
              const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
              
              extractedImages.push({
                name: f.fileHeader.name,
                base64,
                mimeType
              });
            }
          }
        }
      } else {
        throw new Error("Unsupported file format. Please upload a .zip or .rar file.");
      }

      if (extractedImages.length === 0) {
        throw new Error("No PNG or JPEG images found in the uploaded archive.");
      }

      setImages(extractedImages);
      
      // Generate preview for the first image
      const firstImage = extractedImages[0];
      setPreviewOriginal(firstImage);
      
      setProgress({ current: 0, total: 3, label: 'Generating Portuguese preview...' });
      const pt = await translateImage(firstImage.base64, firstImage.mimeType, 'Portuguese');
      
      setProgress({ current: 1, total: 3, label: 'Generating French preview...' });
      const fr = await translateImage(firstImage.base64, firstImage.mimeType, 'French');
      
      setProgress({ current: 2, total: 3, label: 'Generating English preview...' });
      const en = await translateImage(firstImage.base64, firstImage.mimeType, 'English');
      
      setPreviewTranslated({ pt, fr, en });
      setAppState('PREVIEW');
      
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to process the archive file.");
      setAppState('UPLOAD');
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleBulkTranslate = async () => {
    setAppState('PROCESSING_BULK');
    setError(null);
    
    let currentTranslated = [...translatedFiles];
    const totalOperations = images.length * 3;
    
    try {
      for (const img of images) {
        const baseName = img.name.substring(0, img.name.lastIndexOf('.'));
        const ext = img.name.substring(img.name.lastIndexOf('.'));
        
        const languages = [
          { code: 'PT', name: 'Portuguese' },
          { code: 'FR', name: 'French' },
          { code: 'EN', name: 'English' }
        ];

        for (const lang of languages) {
          const targetFileName = `${baseName}_${lang.code}${ext}`;
          
          if (currentTranslated.some(f => f.fileName === targetFileName)) {
            continue;
          }

          setProgress({ current: currentTranslated.length, total: totalOperations, label: `Translating ${img.name} to ${lang.name}...` });
          const base64 = await translateImage(img.base64, img.mimeType, lang.name);
          
          currentTranslated.push({ fileName: targetFileName, base64 });
          setTranslatedFiles([...currentTranslated]);
        }
      }
      
      setProgress({ current: currentTranslated.length, total: totalOperations, label: 'Zipping files...' });
      const resultZipFile = new JSZip();
      for (const file of currentTranslated) {
        resultZipFile.file(file.fileName, file.base64, { base64: true });
      }
      const content = await resultZipFile.generateAsync({ type: 'blob' });
      setResultZip(content);
      setAppState('DONE');
      
    } catch (err: any) {
      console.error(err);
      setError(err.message || "An error occurred during bulk translation.");
      
      if (currentTranslated.length > 0) {
        const partialZip = new JSZip();
        for (const file of currentTranslated) {
          partialZip.file(file.fileName, file.base64, { base64: true });
        }
        const content = await partialZip.generateAsync({ type: 'blob' });
        setResultZip(content);
      }
      
      setAppState('PREVIEW'); // Go back to preview so they can retry
    }
  };

  const downloadZip = () => {
    if (resultZip) {
      saveAs(resultZip, 'translated_infographics.zip');
    }
  };

  const reset = () => {
    setAppState('UPLOAD');
    setImages([]);
    setPreviewOriginal(null);
    setPreviewTranslated(null);
    setResultZip(null);
    setTranslatedFiles([]);
    setError(null);
  };

  if (!apiKeySelected) {
    return (
      <div className="min-h-screen bg-[#f5f5f5] flex items-center justify-center p-6 font-sans text-gray-900">
        <div className="bg-white p-10 rounded-3xl shadow-sm max-w-md w-full text-center border border-gray-100">
          <div className="w-16 h-16 bg-orange-100 text-orange-600 rounded-full flex items-center justify-center mx-auto mb-6">
            <KeyRound size={32} />
          </div>
          <h2 className="text-2xl font-semibold mb-4">API Key Required</h2>
          <p className="text-gray-600 mb-8 leading-relaxed">
            This application uses the <strong>Gemini 3.1 Flash Image</strong> model to edit images, which requires a paid Google Cloud API key.
            Please select your API key to continue.
          </p>
          <button
            onClick={handleSelectKey}
            className="bg-black text-white px-6 py-4 rounded-full font-medium w-full hover:bg-gray-800 transition-colors shadow-lg shadow-black/10"
          >
            Select API Key
          </button>
          <p className="text-xs text-gray-400 mt-6">
            <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noreferrer" className="underline hover:text-gray-600">
              Learn more about billing
            </a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f5f5f5] font-sans text-gray-900 pb-20">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-black rounded-xl flex items-center justify-center text-white">
            <Languages size={20} />
          </div>
          <div>
            <h1 className="font-semibold text-lg leading-tight">Infographic Translator</h1>
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">Powered by Gemini 3.1 Flash Image</p>
          </div>
        </div>
        {appState !== 'UPLOAD' && (
          <button 
            onClick={reset}
            className="text-sm font-medium text-gray-500 hover:text-black transition-colors flex items-center gap-2"
          >
            <RefreshCw size={16} />
            Start Over
          </button>
        )}
      </header>

      <main className="max-w-6xl mx-auto px-6 py-12">
        {error && (
          <div className="mb-8 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl flex items-start gap-3">
            <AlertCircle className="shrink-0 mt-0.5" size={18} />
            <div className="flex-1">
              <p className="text-sm font-medium">{error}</p>
              {translatedFiles.length > 0 && appState === 'PREVIEW' && (
                <p className="text-xs mt-1 text-red-600">
                  Don't worry, your progress is saved. You can download the {translatedFiles.length} images completed so far, or retry the remaining ones.
                </p>
              )}
            </div>
          </div>
        )}

        {/* UPLOAD STATE */}
        {appState === 'UPLOAD' && (
          <div className="max-w-2xl mx-auto">
            <div className="text-center mb-10">
              <h2 className="text-4xl font-light tracking-tight mb-4">Bulk Translate Images</h2>
              <p className="text-gray-500">Upload a ZIP or RAR file containing your .png infographics. We'll translate them to Portuguese, French, and English while perfectly preserving the original design.</p>
            </div>

            <div 
              onClick={() => fileInputRef.current?.click()}
              className="bg-white border-2 border-dashed border-gray-300 rounded-3xl p-16 text-center cursor-pointer hover:border-black hover:bg-gray-50 transition-all group"
            >
              <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform">
                <Upload size={32} className="text-gray-400 group-hover:text-black transition-colors" />
              </div>
              <h3 className="text-xl font-medium mb-2">Click to upload ZIP or RAR</h3>
              <p className="text-sm text-gray-400">Contains .png or .jpg files</p>
              <input 
                type="file" 
                accept=".zip,.rar" 
                className="hidden" 
                ref={fileInputRef}
                onChange={handleFileUpload}
              />
            </div>
          </div>
        )}

        {/* GENERATING PREVIEW STATE */}
        {appState === 'GENERATING_PREVIEW' && (
          <div className="max-w-md mx-auto text-center py-20">
            <Loader2 size={48} className="animate-spin mx-auto mb-6 text-black" />
            <h2 className="text-2xl font-light mb-2">Generating Preview</h2>
            <p className="text-gray-500 mb-8">Translating the first image to PT, FR, and EN to show you a sample...</p>
            
            <div className="w-full bg-gray-200 rounded-full h-2 mb-2 overflow-hidden">
              <div 
                className="bg-black h-2 rounded-full transition-all duration-500 ease-out" 
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              ></div>
            </div>
            <p className="text-xs font-mono text-gray-400 uppercase tracking-widest">{progress.label}</p>
          </div>
        )}

        {/* PREVIEW STATE */}
        {appState === 'PREVIEW' && previewOriginal && previewTranslated && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="flex items-end justify-between mb-8">
              <div>
                <h2 className="text-3xl font-light tracking-tight mb-2">Preview Translation</h2>
                <p className="text-gray-500">Review the sample below. If it looks good, we'll process all {images.length} images.</p>
                {translatedFiles.length > 0 && (
                  <p className="text-sm font-medium text-green-600 mt-2">
                    {translatedFiles.length} of {images.length * 3} translations completed.
                  </p>
                )}
              </div>
              <div className="flex gap-4">
                {resultZip && translatedFiles.length > 0 && (
                  <button 
                    onClick={downloadZip}
                    className="bg-white border border-gray-200 text-black px-6 py-4 rounded-full font-medium flex items-center gap-2 hover:bg-gray-50 transition-colors shadow-sm"
                  >
                    <Download size={18} />
                    Download Partial ZIP
                  </button>
                )}
                <button 
                  onClick={handleBulkTranslate}
                  className="bg-black text-white px-8 py-4 rounded-full font-medium flex items-center gap-2 hover:bg-gray-800 transition-colors shadow-lg shadow-black/10"
                >
                  {translatedFiles.length > 0 ? 'Retry Remaining' : 'Approve & Translate All'}
                  <ArrowRight size={18} />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* Original */}
              <div className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-medium flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-gray-300"></span>
                    Original Image
                  </h3>
                  <span className="text-xs font-mono text-gray-400 bg-gray-100 px-2 py-1 rounded">{previewOriginal.name}</span>
                </div>
                <div className="bg-gray-50 rounded-2xl overflow-hidden border border-gray-100 aspect-[3/4] flex items-center justify-center relative">
                  <img 
                    src={`data:${previewOriginal.mimeType};base64,${previewOriginal.base64}`} 
                    alt="Original" 
                    className="max-w-full max-h-full object-contain"
                  />
                </div>
              </div>

              {/* Translations Grid */}
              <div className="grid grid-rows-3 gap-4">
                {/* PT */}
                <div className="bg-white p-4 rounded-3xl shadow-sm border border-gray-100 flex gap-6 items-center">
                  <div className="w-32 h-32 shrink-0 bg-gray-50 rounded-xl overflow-hidden border border-gray-100 flex items-center justify-center relative">
                    <img 
                      src={`data:${previewOriginal.mimeType};base64,${previewTranslated.pt}`} 
                      alt="Portuguese" 
                      className="max-w-full max-h-full object-contain"
                    />
                  </div>
                  <div>
                    <h3 className="font-medium text-lg mb-1">Portuguese (PT)</h3>
                    <p className="text-sm text-gray-500">Layout and visuals preserved.</p>
                  </div>
                </div>

                {/* FR */}
                <div className="bg-white p-4 rounded-3xl shadow-sm border border-gray-100 flex gap-6 items-center">
                  <div className="w-32 h-32 shrink-0 bg-gray-50 rounded-xl overflow-hidden border border-gray-100 flex items-center justify-center relative">
                    <img 
                      src={`data:${previewOriginal.mimeType};base64,${previewTranslated.fr}`} 
                      alt="French" 
                      className="max-w-full max-h-full object-contain"
                    />
                  </div>
                  <div>
                    <h3 className="font-medium text-lg mb-1">French (FR)</h3>
                    <p className="text-sm text-gray-500">Layout and visuals preserved.</p>
                  </div>
                </div>

                {/* EN */}
                <div className="bg-white p-4 rounded-3xl shadow-sm border border-gray-100 flex gap-6 items-center">
                  <div className="w-32 h-32 shrink-0 bg-gray-50 rounded-xl overflow-hidden border border-gray-100 flex items-center justify-center relative">
                    <img 
                      src={`data:${previewOriginal.mimeType};base64,${previewTranslated.en}`} 
                      alt="English" 
                      className="max-w-full max-h-full object-contain"
                    />
                  </div>
                  <div>
                    <h3 className="font-medium text-lg mb-1">English (EN)</h3>
                    <p className="text-sm text-gray-500">Layout and visuals preserved.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* PROCESSING BULK STATE */}
        {appState === 'PROCESSING_BULK' && (
          <div className="max-w-md mx-auto text-center py-20">
            <Loader2 size={48} className="animate-spin mx-auto mb-6 text-black" />
            <h2 className="text-2xl font-light mb-2">Translating Images</h2>
            <p className="text-gray-500 mb-8">Processing {images.length} images into 3 languages each...</p>
            
            <div className="w-full bg-gray-200 rounded-full h-2 mb-4 overflow-hidden">
              <div 
                className="bg-black h-2 rounded-full transition-all duration-300 ease-out" 
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              ></div>
            </div>
            <div className="flex justify-between items-center text-xs font-mono text-gray-400 uppercase tracking-widest">
              <span>{progress.label}</span>
              <span>{Math.round((progress.current / progress.total) * 100)}%</span>
            </div>
          </div>
        )}

        {/* DONE STATE */}
        {appState === 'DONE' && (
          <div className="max-w-md mx-auto text-center py-20 animate-in zoom-in-95 duration-500">
            <div className="w-24 h-24 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-8">
              <CheckCircle2 size={48} />
            </div>
            <h2 className="text-4xl font-light tracking-tight mb-4">Translation Complete!</h2>
            <p className="text-gray-500 mb-10">Successfully translated {images.length} images into Portuguese, French, and English ({images.length * 3} total images).</p>
            
            <button 
              onClick={downloadZip}
              className="bg-black text-white px-8 py-4 rounded-full font-medium flex items-center justify-center gap-3 hover:bg-gray-800 transition-colors shadow-xl shadow-black/10 w-full text-lg"
            >
              <Download size={24} />
              Download ZIP
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

