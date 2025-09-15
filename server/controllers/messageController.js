import Message from "../models/Message.js";
import User from "../models/User.js";
import cloudinary from "../lib/cloudinary.js";
import { io, userSocketMap } from "../server.js";
import { GoogleGenerativeAI } from "@google/generative-ai";


//Get all user except the logged in user
export const getUsersForSidebar = async (req, res)=>{
    try{
        const userId = req.user._id;
        const filteredUsers = await User.find({_id: {$ne: userId}}).select("-password");

        //Count number of messages not seen
        const unseenMessages = {}
        const promises = filteredUsers.map(async (user)=>{
            const messages = await Message.find({senderId: user._id, receiverId: userId, seen: false})
            if (messages.length > 0)
            {
                unseenMessages[user._id] = messages.length;
            }
        })
        await Promise.all(promises);
        res.json({success: true, users: filteredUsers, unseenMessages})
    } catch (error) {
        console.log(error.message);
        res.json({success: false, message: error.message})
    }
}

//Get all message for selected user
export const getMessages = async (req, res) =>{
    try {
        const { id: selectedUserId } = req.params;
        const myId = req.user._id;

        const messages = await Message.find({
            $or: [
                {senderId: myId, receiverId: selectedUserId},
                {senderId: selectedUserId, receiverId: myId},
            ]
        })
        await Message.updateMany({senderId: selectedUserId, receiverId: myId} , {seen: true});

        res.json({success: true, messages})

    } catch (error) {
    console.log(error.message);
    res.json({success: false, message: error.message})
    }
}

//api to mark message as seen using message id
export const markMessageAsSeen = async (req, res)=>{
    try{
        const { id } = req.params;
        await Message.findByIdAndUpdate(id, {seen: true})
        res.json({success: true})
    } catch (error) {
        console.log(error.message);
        res.json({success: false, message: error.message})
    }
}

//Send message to selected user
export const sendMessage = async (req, res) =>{
    try {
        const {text, image} = req.body;
        const receiverId = req.params.id;
        const senderId  = req.user._id;

        let imageUrl;
        if(image){
            const uploadResponse = await cloudinary.uploader.upload(image)
            imageUrl = uploadResponse.secure_url;
        }
        const newMessage = await Message.create({
            senderId,
            receiverId,
            text,
            image: imageUrl
        })

        //Emit the new message to the receiver's socket
        const receiverSocketId = userSocketMap[receiverId];
        if (receiverSocketId){
            io.to(receiverSocketId).emit("newMessage", newMessage)
        }
        
        res.json({success: true, newMessage});

    } catch(error){
        console.log(error.message);
        res.json({success: false, message: error.message})
    }
}


//Summarizing messages for each selected chat
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export const getChatSummary = async (req, res) => {
  try {
    const { userId } = req.params; // friend's ID
    const loggedInUserId = req.user._id; // from auth middleware

    // Fetch last 100 messages between users
    const messages = await Message.find({
      $or: [
        { senderId: loggedInUserId, receiverId: userId },
        { senderId: userId, receiverId: loggedInUserId }
      ]
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // Format conversation
    const formattedMessages = messages.reverse().map(msg => {
      return `${msg.senderId.toString() === loggedInUserId.toString() ? "You" : "Friend"}: ${msg.text || "[Image/Media]"}`;
    }).join("\n");

    // Call Gemini
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `You are an assistant analyzing a chat conversation.
                        Please:
                        1. Summarize the overall conversation in 3–4 sentences.
                        2. Extract key points or decisions made.
                        3. If there are any action items, list them clearly..Chat:${formattedMessages}`;

    const result = await model.generateContent(prompt);
    const summary = result.response.text();

    res.json({ success: true, summary });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to summarize chat" });
  }
};