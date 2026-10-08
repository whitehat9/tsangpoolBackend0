import "dotenv/config";
import mongoose from "mongoose";
import { StockConceptCSVModel } from "../models/BikeSystemModel3/StockConceptCSV";
import BikesModel from "../models/BikeSystemModel/Bikes";
(async () => {
  await mongoose.connect(process.env.MONGO_URI!);
  const frames = ["ME4HC154CTG118075","ME4HC154DSG044692","ME4HC154DSG044696"];
  const st = await StockConceptCSVModel.find({ $or:[{frameNumber:{$in:frames}},{engineNumber:{$in:["HC15EG2117753","HC15EG2045008"]}}] }).lean();
  console.log("stock matches", st.length);
  st.forEach(s=>console.log(s.frameNumber,s.engineNumber,s.modelVariant,s.costPrice,s.stockStatus.status,Object.keys(s.csvData||{}).join("|"),JSON.stringify(s.csvData).slice(0,400)));
  const bikes = await BikesModel.find({modelName:/shine/i}).select("modelName variants.name priceBreakdown isActive").lean();
  console.log(JSON.stringify(bikes,null,1).slice(0,1500));
  const sr = await mongoose.connection.collection("salesreports").find({frameNo:{$in:frames}}).project({frameNo:1,modelVariant:1,totalPayment:1,matched:1,matchOutcome:1,createdAt:1,detectedColumns:1}).toArray();
  console.log(JSON.stringify(sr,null,1));
  await mongoose.disconnect();
})();
