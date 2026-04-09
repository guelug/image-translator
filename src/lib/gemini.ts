import { GoogleGenAI } from "@google/genai";

export async function translateImage(base64Data: string, mimeType: string, targetLanguage: string): Promise<string> {
  // Instantiate inside the function to ensure it uses the most up-to-date API key
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  
  const prompt = `You are an expert image editor and translator. Translate all text in this image to ${targetLanguage}. It is CRITICAL that you preserve the exact original layout, typography, fonts, colors, and background. Do not alter any illustrations, charts, or visual elements. Only replace the text with the ${targetLanguage} translation, keeping it in the exact same position and style. Return ONLY the modified image.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-image-preview',
      contents: {
        parts: [
          {
            inlineData: {
              data: base64Data,
              mimeType: mimeType,
            },
          },
          {
            text: prompt,
          },
        ],
      },
    });

    let textResponse = "";
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return part.inlineData.data; // Returns base64 string
      }
      if (part.text) {
        textResponse += part.text + " ";
      }
    }

    throw new Error(textResponse.trim() || "No image returned from Gemini");
  } catch (error: any) {
    console.error("Error translating image:", error);
    
    // If we get a permission denied error, it might be due to the API key
    if (error.status === 403 || error.message?.includes('PERMISSION_DENIED') || error.message?.includes('403')) {
      throw new Error(`Permission Denied. Please ensure you have selected a valid paid API key. Details: ${error.message}`);
    }
    
    throw new Error(`Failed to translate to ${targetLanguage}: ${error.message}`);
  }
}


