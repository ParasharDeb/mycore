import "dotenv/config" 
import { client } from "@repo/redis";
import { GoogleGenAI } from "@google/genai";
import {prisma} from "@repo/db"      
async function rating_Interview(){
  const result = await client.brpop( 
        "interview-rating-queue",
        0
    );
  if(!result) {
        console.log("NOT FOUND")
        return
    }
  const interviewId=result[1]
  console.log(interviewId)
  const Interview=await prisma.interview.findUnique({
        where:{
            id:interviewId
        },
        include:{
            messages:true
        }
    })
  const messages=Interview?.messages
  const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });
async function generateText(): Promise<number> {
  const response = await ai.models.generateContent({
    model: "gemini-flash-latest",
    contents: `You are a senior level interviewer.
      Here are the messages:
      ${JSON.stringify(messages)}
      Rate the interview from 0-100.
      Return ONLY the number.`,
  });
  const marks = parseInt(response.text?.trim() ?? "", 10);
  return Number.isNaN(marks) ? 0 : marks;
}
const marks = await generateText();
console.log(marks)
await prisma.interview.update({
  where: {
    id: interviewId,
  },
  data: {
    score: marks,
    status:"Ended"
  },
});
}
rating_Interview()
