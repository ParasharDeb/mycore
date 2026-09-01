import express from "express"
import cors from 'cors'
import { Signindetails, Signupdetails, userdetails } from "./types"
import {prisma} from "@repo/db"
import axios from "axios"
import bcrypt from "bcrypt"
import jwt from "jsonwebtoken"
import { JWT_SECRET } from "./config"
import { authMiddleware, AuthenticatedRequest } from "./middleware"
import { stripe } from "./stripe"

const app=express()
app.use(express.json())
app.use(cors())

app.get("/health", async (_req, res) => {
    const startedAt = Date.now()
    let database: "up" | "down" = "up"

    try {
        await prisma.$queryRaw`SELECT 1`
    } catch (error) {
        database = "down"
        console.error("Health check: database unreachable", error)
    }

    const body = {
        status: database === "up" ? "ok" : "degraded",
        service: "backend",
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        checks: {
            database
        }
    }

    return res.status(database === "up" ? 200 : 503).json(body)
})

app.post("/signup",async(req,res)=>{
    const {success,data}=Signupdetails.safeParse(req.body);
    if(!success){
        return res.status(402).json({
            message:"Please enter the correct credentials"
        })
    }
    try {
        const existingEmail=await prisma.User.findFirst({
            where:{
                email:data?.email
            }
        })
        if(existingEmail){
            return res.status(402).json({
                message:"Email already exists"
            })
        }
        if(!data?.password){
            return res.status(402).json({
                message:"Password is required"
            })
        }
        const hashedPassword=await bcrypt.hash(data?.password,10)
        const user= await prisma.User.create({
            data:{
                username:data?.username,
                password:hashedPassword,
                email:data?.email
            }
        })
        return res.json({
            userId:user.id
        })
    } catch (error) {
        return res.status(402).json({
            message:error
        })
    }
})

app.post("/signin",async(req,res)=>{
    const {success,data}=Signindetails.safeParse(req.body)
    if(!success){
        return res.status(402).json({
            message:"Invalid credentials"
        })
    }
    try {
        const existingUser=await prisma.User.findFirst({
            where:{
                email:data?.email
            }
        })
        if(!existingUser){
            return res.status(402).json({
                message:"Email doesnt exist"
            })
        }
        if(!data?.password){
            return res.status(402).json({
                message:"Password is required"
            })
        }
        const matchedpassword=await bcrypt.compare(data.password,existingUser.password)
        if(!matchedpassword){
            return res.status(402).json({
                message:"Password incorrect"
            })
        }
        const token=jwt.sign({ userId: existingUser.id },JWT_SECRET)
        return res.json({
            token:token
        })
    } catch (error) {
        return res.status(402).json({
            message:error
        })
    }
})

app.post("/github-verification", authMiddleware, async (req: AuthenticatedRequest, res) => {
    const {success,data}=userdetails.safeParse(req.body)
    if(!success){
        res.status(401).json({
            message:"Invalid links"
        })
        return
    }
    const githuburl=data.githuburl.endsWith("/")?data.githuburl.slice(0,-1):data.githuburl
    const githubname=githuburl.split("/").pop()
    const githubUserdata=await axios.get(`https://api.github.com/users/${githubname}/repos`)
    const githubrepodetails=githubUserdata.data.map((x:any)=>({
        description:x.description,
        name:x.name,
        fullName:x.fullName,
        starcount:x.stargazers_count
    }))
    try {
        const interview= await prisma.interview.create({
            data:{
                githubmetadata:githubrepodetails,
                status:'Inprocess',
                userID: req.userId!
            }
        })
        res.json({
            "id":interview.id,
            "role": data.role || "General"
        })
    } catch (error) {
        res.json({
            "error":error
        })
    }

})

app.get("/users", authMiddleware, async (_req, res) => {
    try {
        const users = await prisma.User.findMany({
            select: {
                id: true,
                username: true,
                email: true,
                tokens: true
            },
            orderBy: {
                username: "asc"
            }
        })
        return res.json(users)
    } catch (error) {
        return res.status(500).json({ message: "Unable to fetch users" })
    }
})

app.get("/users/:id", authMiddleware, async (req, res) => {
    const { id } = req.params

    try {
        const user = await prisma.User.findUnique({
            where: { id },
            select: {
                id: true,
                username: true,
                email: true,
                tokens: true
            }
        })

        if (!user) {
            return res.status(404).json({ message: "User not found" })
        }

        return res.json(user)
    } catch (error) {
        return res.status(500).json({ message: "Unable to fetch user" })
    }
})

app.get("/user/tokens", authMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
        const user = await prisma.User.findUnique({
            where: { id: req.userId! },
            select: { tokens: true }
        })

        if (!user) {
            return res.status(404).json({ message: "User not found" })
        }

        const totalTokens = user.tokens || 0
        return res.json({
            totalTokens,
            usedTokens: 0,
            remainingTokens: totalTokens
        })
    } catch (error) {
        return res.status(500).json({ message: "Unable to fetch token usage" })
    }
})

app.get("/user/interviews", authMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
        const interviews = await prisma.interview.findMany({
            where: { userID: req.userId! },
            orderBy: { id: "desc" },
            include: {
                _count: {
                    select: { messages: true }
                }
            }
        })

        return res.json(interviews.map((interview: any) => ({
            id: interview.id,
            role: interview.githubmetadata?.[0]?.name || "General",
            createdAt: new Date().toISOString(),
            messageCount: interview._count.messages,
            status: interview.status,
            score: interview.score,
            feedback: interview.feedback
        })))
    } catch (error) {
        return res.status(500).json({ message: "Unable to fetch interviews" })
    }
})

app.get("/users/:id/interviews", authMiddleware, async (req, res) => {
    const { id } = req.params

    try {
        const interviews = await prisma.interview.findMany({
            where: { userID: id },
            orderBy: { id: "desc" },
            include: {
                _count: {
                    select: { messages: true }
                }
            }
        })

        return res.json(interviews.map((interview: any) => ({
            id: interview.id,
            role: interview.githubmetadata?.[0]?.name || "General",
            createdAt: new Date().toISOString(),
            messageCount: interview._count.messages,
            status: interview.status,
            score: interview.score,
            feedback: interview.feedback
        })))
    } catch (error) {
        return res.status(500).json({ message: "Unable to fetch user interviews" })
    }
})

app.get("/interview/:id/messages", authMiddleware, async (req, res) => {
    const { id } = req.params

    try {
        const messages = await prisma.Messages.findMany({
            where: { interviewid: id },
            orderBy: { sentAt: "asc" }
        })

        return res.json({
            messages: messages.map((message: any) => ({
                id: message.id,
                text: message.messages,
                sender: message.type === "AIassistent" ? "ai" : "me",
                createdAt: message.sentAt.toISOString()
            }))
        })
    } catch (error) {
        return res.status(500).json({ message: "Unable to fetch interview messages" })
    }
})

app.get("/interview/:id", authMiddleware, async (req: AuthenticatedRequest, res) => {
    const {id} = req.params
    if(!id){
        return
    }
    try {
          const data = await prisma.interview.findFirst({
        where:{
            id:id
        }
    })
    res.json({
        "githubdata":data?.githubmetadata
    })  
    } catch (error) {
        res.json({
            "message":error
        })
    }

    
})
const PLANS = {
  starter: {
    credits: 3,
    priceId: process.env.STRIPE_STARTER_PRICE_ID!,
  },
  pro: {
    credits: 10,
    priceId: process.env.STRIPE_PRO_PRICE_ID!,
  },
  max: {
    credits: 20,
    priceId: process.env.STRIPE_MAX_PRICE_ID!,
  },
} as const;

app.post(
  "/stripe/create-checkout-session",
  authMiddleware,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { planId } = req.body;

      const plan = PLANS[planId as keyof typeof PLANS];

      if (!plan) {
        return res.status(400).json({
          message: "Invalid plan",
        });
      }

      const user = await prisma.User.findUnique({
        where: {
          id: req.userId!,
        },
      });

      if (!user) {
        return res.status(404).json({
          message: "User not found",
        });
      }

      const session = await stripe.checkout.sessions.create({
        mode: "payment",

        line_items: [
          {
            price: plan.priceId,
            quantity: 1,
          },
        ],

        metadata: {
          userId: user.id,
          planId: planId,
          credits: String(plan.credits),
        },

        success_url:
          `${process.env.FRONTEND_URL}/payment/success`,

        cancel_url:
          `${process.env.FRONTEND_URL}/payment`,
      });

      return res.json({
        url: session.url,
      });
    } catch (error) {
      console.error("Stripe checkout error:", error);

      return res.status(500).json({
        message: "Unable to create checkout session",
      });
    }
  }
);
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Backend listening on ${PORT}`);
});