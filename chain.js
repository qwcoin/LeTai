var CryptoJS = require("crypto-js");
var express = require("express");
var bodyParser = require('body-parser');
var WebSocket = require("ws");
var MongoClient = require('mongodb').MongoClient;
var ethers = require("ethers");
var secp256k1_1 = require("./node_modules/ethers/utils/secp256k1");
var fs = require('fs');
var os=require("os");
var http = require('http'); 
var https = require('https');

var version = "1.2";
var url = "mongodb://localhost:27017/";
var http_port = 8001;
var https_port = 8002;
var p2p_port = 6001;
var initialPeers = [
	"47.88.158.78",
	"47.244.137.9",
	"47.91.43.203",
	"47.254.232.127",
	"47.88.87.160",
	"47.74.19.251",
	"8.208.8.248",
	"8.209.81.102",
	"47.252.7.84",
	"149.129.226.187",
	"47.91.115.238",
	"115.29.160.32"];

var app = express();
var myip = "";
var dbo={};           //数据库操作对象
var latestBlock={};   //最新区块
var sockets = [];     //连接对象列表
var peddingTransations = [];   //未上链交易
var makerIp = "115.29.160.32";
var makerWs = null;


class Block {
    constructor(index, previousHash, timestamp, transation, maker,hash) {
        this.index = index;
        this.previousHash = previousHash.toString();
        this.timestamp = timestamp;
		this.transation = transation;
		this.maker = maker;
        this.hash = hash.toString();
    }
}

var MessageType = {
    QUERY_LATEST: 0,
	QUERY_MASS: 1,
	RESPONSE_BLOCKCHAIN: 2,
	NUMBER: 3,
	RESPONSE_NUMBER: 4,
	NEWMAKER:5,
	NEWTX:6,
	MAKER: 7,
	RESPONSE_MAKER: 8,
	ADDTX: 9
};


var urlencodedParser = bodyParser.urlencoded({extended: false});
var jsonReturn = (code,msg) => {return {"code":code,"message":msg};}

var initHttpServer = () => {
	app.listen(http_port, () => console.log('Listening http on port: ' + http_port));   
    app.use(bodyParser.json());
    app.all("*",function(req,res,next){
        //设置允许跨域的域名，*代表允许任意域名跨域
        res.header("Access-Control-Allow-Origin","*");
        //允许的header类型
        res.header("Access-Control-Allow-Headers","content-type");
        //跨域允许的请求方式 
        res.header("Access-Control-Allow-Methods","DELETE,PUT,POST,GET,OPTIONS");
        if (req.method.toLowerCase() == 'options')
			res.status(200).send("OK")  //让options尝试请求快速结束
        else
            next();
    });

	app.get("/getBalance",(req,res)=>{
			common.getBalance(req.query.contract||{$exists:false},req.query.account).then(function onFulfilled(value){
				res.send(jsonReturn(0,value));
			}).catch(function onRejected(error){
				console.error(error);
				if (err){res.send(jsonReturn(-999,err));return;}
			});
    });

    app.get("/getBlock",(req,res)=>{
			var number = req.query.number;
            dbo.collection("block").findOne({"index":number-0},function(err, result) { 
                if (err){res.send(jsonReturn(-999,err));return;}
                res.send(jsonReturn(0,result));
            });
	});

	app.get("/getTx",(req,res)=>{
			var account = req.query.account;
            dbo.collection("block").find({"$or":[{"transation.from":account},{"transation.to":account}],"transation.contract":req.query.contract||{$exists:false}}).sort({"index":-1}) .toArray(function(err, result) { 
				if (err){res.send(jsonReturn(-999,err));return;}
				res.send(jsonReturn(0,result));
            });
    });
    app.get("/getBlockHeight",(req,res)=>{res.send(jsonReturn(0,latestBlock.index));});

    app.get("/peers",(req,res)=>{
		 res.send(jsonReturn(0,sockets.length+1));
	});
	
	app.get("/peerls",(req,res)=>{
		let peers={};
		sockets.forEach((ws) => {
			peers[ipv6To4(ws._socket.remoteAddress)]={"port":ws._socket.remotePort,"block":ws.block,"maker":ws.maker};
		});
		if(!peers.hasOwnProperty(myip))
		{
			peers[myip]={"maker":(myip==makerIp),"port":6001,"block":latestBlock.index};
		}
		res.send(jsonReturn(0,peers));
	});
	app.post("/newAccount",(req,res)=>{
			var d=req.body;
			var namepatt = /^\w{12}$/;
			if(!namepatt.test(d.account)){res.send(jsonReturn(-11,"account format error")); return;}

			var addrpatt = /^\w{42}$/;
		    if(!addrpatt.test(d.address)){res.send(jsonReturn(-12,"address format error"));return;}
			
			var namepatt = /^\w{12}$/;
			if(!namepatt.test(d.from) && d.from!="system"){res.send(jsonReturn(-13,"from account format error")); return;}
			if(isNaN(d.timestamp)){res.send(jsonReturn(-14,"timestamp error"));return;}

			dbo.collection("block").findOne({"transation.to":d["account"]},{"index":1},function(err, result) { 
				if (err){res.send(jsonReturn(-999,err));return;}
				if(result)
				{
					res.send(jsonReturn(-1,"account exist"));	return;
				}
				else 
				{
					d["hash"] = CryptoJS.SHA256(d.from + d.to + d.amount+d.fee+d.timestamp+d.data).toString();
					var address = secp256k1_1.verifyMessage(d.hash,d.sign);
						dbo.collection("block").findOne({"transation.to":d.from},function(err, fromaccount) { 
							if (err){res.send(jsonReturn(-999,err));return;}
							if(!fromaccount){
								res.send(jsonReturn(-2,"from account not exist"));	return;
							}
							else 
							{
								let uaddr=[];
								fromaccount.transation.forEach((v)=>{
									if(v.from==0 && v.to==d.from){uaddr.push(v.data);}
								});
								if(!uaddr.includes(address)){
									res.send(jsonReturn(-3,"sign check error"));	return;
								}
								else
								{
									d.amount=3;
									common.transfer(d).then(function onFulfilled(value){
											var d2={
												"from": "0",
												"to": d.account,
												"amount": 0,
												"fee": 0,
												"data":d.address
											};
											common.sendToMaker(d2);
											res.send(jsonReturn(0,"ok"));
									}).catch(function onRejected(error){
										console.error(error);
										res.send(jsonReturn(-999,error));return;
									});
								}
							}
						});
				}
			});		
			
	});
	
	app.post('/transation',(req,res) =>{
		var d=req.body;
		var namepatt = /^\w{12}$/;
		if(!namepatt.test(d.from) && d.from!="system"){res.send(jsonReturn(-11,"from account format error"));return;}
		if(!namepatt.test(d.to)){res.send(jsonReturn(-12,"to account format error"));return;}
		if(isNaN(d.amount) || d.amount<0){res.send(jsonReturn(-13,"amount error"));return;}
		if(isNaN(d.timestamp)){res.send(jsonReturn(-14,"timestamp error"));return;}

		d["hash"] = CryptoJS.SHA256(d.from + d.to + d.amount+d.fee+d.timestamp+d.data).toString();
		var address = secp256k1_1.verifyMessage(d.hash,d.sign);
		dbo.collection("block").findOne({"transation.to":d.from},function(err, fromaccount) { 
			if (err){res.send(jsonReturn(-999,err));return;}
			if(!fromaccount){
				res.send(jsonReturn(-1,"from account not exist"));	return;
			}
			else 
			{
				let uaddr=[];
				fromaccount.transation.forEach((v)=>{
					if(v.from==0 && v.to==d.from){uaddr.push(v.data);}
				});
				if(!uaddr.includes(address)){
					res.send(jsonReturn(-3,"sign check error"));	return;
				}
				else
				{
					common.transfer(d).then(function onFulfilled(value){
						res.send(jsonReturn(0,value));
					}).catch(function onRejected(error){
						console.error(error);
						res.send(jsonReturn(-999,error));return;
					});
				}
			}
		});
		
	});

	app.get("/getTxByHash",(req,res)=>{
			dbo.collection("block").findOne({"transation.hash":req.query.hash},function(err, result) { 
			if (err){res.send(jsonReturn(-999,err));return;}
			if(result)
			{
				res.send(jsonReturn(0,result));
			}
		});
	});

	app.get("/checkAccount",(req,res)=>{
			var addrpatt = /^\w{42}$/;
		    if(!addrpatt.test(req.query.address)){res.send(jsonReturn(-11,"address format error"));return;}

            dbo.collection("block").findOne({"transation.data":req.query.address},{"index":1},function(err, result) { 
				if (err){res.send(jsonReturn(-999,err));return;}
                if(!result)
				{
					res.send(jsonReturn(-1,"account not exist"));
					return;
				}
				else 
				{
					result.transation.forEach((v)=>{
						if(v.data==req.query.address){
							res.send(jsonReturn(0,v.to));
						}
					});
					return;
				}
            });
			
    });

	
	app.post("/newContract",(req,res)=>{
			var d=req.body;

			var namepatt = /^\w{2,11}$/;
			if(!namepatt.test(d["newContract"])){res.send(jsonReturn(-11,"contract name format error"));return;}
			
			var namepatt = /^\w{12}$/;
			if(!namepatt.test(d.from) && d.from!="system"){res.send(jsonReturn(-12,"from account format error"));return;}
			if(isNaN(d.amount) || d.amount<1000){res.send(jsonReturn(-13,"amount error"));return;}
			if(isNaN(d.timestamp)){res.send(jsonReturn(-14,"timestamp error"));return;}

			dbo.collection("block").findOne({"transation.newContract":d["newContract"]},{"index":1},function(err, result) { 
				if (err){res.send(jsonReturn(-999,err));return;}
				if(result)
				{
					res.send(jsonReturn(-1,"contract exist"));	return;
				}
				else 
				{
						d["hash"] = CryptoJS.SHA256(d.from + d.to + d.amount+d.fee+d.timestamp+d.data).toString();
						var address = secp256k1_1.verifyMessage(d.hash,d.sign);
						dbo.collection("block").findOne({"transation.to":d.from},function(err, fromaccount) { 
							if (err){res.send(jsonReturn(-999,err));return;}
							if(!fromaccount){
								res.send(jsonReturn(-2,"from account not exist"));	return;
							}
							else 
							{
								let uaddr=[];
								fromaccount.transation.forEach((v)=>{
									if(v.from==0 && v.to==d.from){uaddr.push(v.data);}
								});
								if(!uaddr.includes(address)){
									res.send(jsonReturn(-3,"sign check error"));	return;
								}
								else
								{
								
									common.transfer(d).then(function onFulfilled(value){
										try
										{
											let tmp = JSON.parse(d["data"].replace(new RegExp("\r\n","gm"),""));
											console.log(tmp);
											let d2={
												"from": "0",
												"to": tmp.owner,
												"amount": tmp.totalSupply-0,
												"contract": tmp.name,
												"fee": 0,
												"data": ""
											};
											common.sendToMaker(d2);
											res.send(jsonReturn(0,"ok"));
										}
										catch(ee)
										{
											res.send(jsonReturn(-4,"data parse error"));	return;
										}			
									}).catch(function onRejected(error){
										console.error(error);
										res.send(jsonReturn(-999,error));return;
									});
								}
							}
						});
				}
			});		
    });


	app.get("/getAccountInfo",(req,res)=>{
		 dbo.collection("block").findOne({"transation.to":req.query.account},function(err, result) { 
				if (err){res.send(jsonReturn(-999,err));return;}
                if(result)
				{
					let m ={"createTime":result.timestamp,"balance":{"LT":0}};
					dbo.collection("block").aggregate([  
						{ $match : { "transation.from" : req.query.account}}, 
						{$unwind:'$transation'},
						{ $group : { _id : {"f":"$transation.from","c":"$transation.contract"}, total : {$sum : "$transation.amount"} }}  
					]).toArray(function(err1, result1) { 
						if (err1){res.send(jsonReturn(-999,err1));return;}
						dbo.collection("block").aggregate([  
							{ $match : { "transation.to" : req.query.account}}, 
							{$unwind:'$transation'},
							{ $group : { _id : {"t":"$transation.to","c":"$transation.contract"}, total : {$sum : "$transation.amount"} }}  
						]).toArray(function(err2, result2) { 
							if (err2){res.send(jsonReturn(-999,err2));return;}

							if(result2.length>0)
							{
								result2.forEach((v)=>{
									if(v._id.t==req.query.account)
									{
										if(v._id.hasOwnProperty("c"))
										{
											m.balance[v._id.c]=v.total;
										}
										else
										{
											m.balance["LT"]=v.total;
										}
										
									}
								});
							}

							if(result1.length>0)
							{
								result1.forEach((v)=>{
									if(v._id.f==req.query.account)
									{
										if(v._id.hasOwnProperty("c"))
										{
											m.balance[v._id.c]-=v.total;
										}
										else
										{
											m.balance["LT"]-=v.total;
										}
										
									}
								});
							}
							res.send(jsonReturn(0,m));
						});
					});
				}
				else {
					res.send(jsonReturn(-1,"account not exist"));	return;
				}

				
		 });
    });

	app.get("/getContractInfo",(req,res)=>{
		 dbo.collection("block").findOne({"transation.newContract":req.query.contract},function(err, result) { 
				if (err){res.send(jsonReturn(-999,err));return;}
                if(result)
				{
					res.send(jsonReturn(0,result));
				}
				else {
					res.send(jsonReturn(-1,"contract not exist"));	return;
				}
		 });
    });

	app.get("/getAccountTx",(req,res)=>{
			var account = req.query.account;
            dbo.collection("block").find({"$or":[{"transation.from":account},{"transation.to":account}]}).sort({"index":-1}) .toArray(function(err, result) { 
                if (err){res.send(jsonReturn(-999,err));return;}
				res.send(jsonReturn(0,result));
            });
    });

	app.get("/getContractTx",(req,res)=>{
            dbo.collection("block").find({"transation.contract":req.query.contract||{$exists:false}}).sort({"index":-1}) .toArray(function(err, result) { 
				if (err){res.send(jsonReturn(-999,err));return;}
				res.send(jsonReturn(0,result));
            });
    });

	app.get("/getContracts",(req,res)=>{
            dbo.collection("block").find({"transation.newContract":{$exists:true}}).sort({"index":-1}) .toArray(function(err, result) { 
                if (err){res.send(jsonReturn(-999,err));return;}
                res.send(jsonReturn(0,result));
            });
    });

	app.get("/getNewTxs",(req,res)=>{
		dbo.collection("block").find({},{sort:{'index': -1}}).limit(10).toArray(function(err, result) { 
			if (err){res.send(jsonReturn(-999,err));return;}
			res.send(jsonReturn(0,result));
		});
	});
};

class common {
	static getBalance(contract,account)
	{
		return new Promise(function (resolve, reject) {
			dbo.collection("block").aggregate([  
				{ $match : { "transation.from" : account}}, 
				{$unwind:'$transation'},
				{ $group : { _id : {"f":"$transation.from","c":"$transation.contract"}, total : {$sum : "$transation.amount"} }}  
			]).toArray(function(err, result) { 
				if (err) {reject(err);}
				//console.log(JSON.stringify(result));
				dbo.collection("block").aggregate([  
					{ $match : { "transation.to" : account}}, 
					{$unwind:'$transation'},
					{ $group : { _id : {"t":"$transation.to","c":"$transation.contract"}, total : {$sum : "$transation.amount"} }}  
				]).toArray(function(err2, result2) { 
					//console.log(JSON.stringify(result2));
					if (err2) {reject(err2);}
					let from =0;
					let to =0;
					let isContract=true;
					if(contract.hasOwnProperty("$exists") && !contract.$exists)
					{
						isContract=false;
					}
					if(result.length>0)
					{
						result.forEach((v)=>{
							if(((!isContract &&!v._id.hasOwnProperty("c")) || (isContract && v._id.c==contract))&&v._id.f==account)
							{from =v.total;return;}
						});
						
					}
					if(result2.length>0)
					{
						
						result2.forEach((v)=>{
							if(((!isContract &&!v._id.hasOwnProperty("c")) || (isContract && v._id.c==contract))&&v._id.t==account)
							{to =v.total;return;}
						});
					}
					var b = to - from;
					resolve(b);
				});
			});
		});
	}

	static transfer(d)
	{
		return new Promise(function (resolve, reject) {
			common.getBalance(d.contract||{$exists:false},d.from).then(function onFulfilled(b){
				if(b>=d.amount)
				{
					dbo.collection("block").findOne({"transation.hash":d.hash},function(err, result) { 
						if (err){console.error(err);;return;}
						if(result)
						{
							reject("hash exist");
						}
						else
						{
							common.sendToMaker(d);
							resolve(d.hash);
						}
					});
					
				}
				else {
					reject("balance is insufficient"); 
				}
			}).catch(function onRejected(error){
				console.error(error);
			});

		});						
	}

	static sendToMaker(d)
	{
		
		if(makerIp==myip)
		{
			peddingTransations.push(d);
			console.log("peddingTransations:"+peddingTransations.length);
		}
		else
		{
			if(makerWs!=null)
			{
				write(makerWs, {'type':MessageType.ADDTX,'data':JSON.stringify(d)});
				console.log("send to maker");
			}
		}
	}
}
var ipv6To4=(ip)=>{
	let arr = ip.split(":");
	return arr[arr.length-1];
};

var initP2PServer = () => {
    var server = new WebSocket.Server({port: p2p_port});
	server.on('connection', (ws,req) => onConnection(ws,req));
	server.on('error', (err) => {console.log("server  error");});
	console.log('listening websocket p2p port on: ' + p2p_port);
};
var onConnection = (ws) => {
	ws["maker"]=false;
	ws["block"]=-1;
	sockets.push(ws);
	console.log(ipv6To4(ws._socket.remoteAddress) +" connectok! socket count:"+sockets.length);
    messageHandler(ws);
    errorHandler(ws);
};

var connectToPeers = () => {
	initialPeers.forEach((peer) => {
			if(peer==myip)return;
			var ws = new WebSocket("ws://"+peer+":6001");
			ws.on('open', () => onOpen(ws));
			ws.on('error', (err) => {});
		});
	setTimeout(getMainBlockNumber,1000);
	setInterval(getMainBlockNumber,5000);
};
var onOpen = (ws) => {
	ws["maker"]=false;
	ws["block"]=-1;
    sockets.push(ws);
	console.log(ipv6To4(ws._socket.remoteAddress) +" open connectok! socket count:"+sockets.length);
	if(makerIp==ipv6To4(ws._socket.remoteAddress))
	{
		makerWs=ws;
	}
    messageHandler(ws);
    errorHandler(ws);
};
var messageHandler = (ws) => {
    ws.on('message', (data) => {
        var message = JSON.parse(data);
        switch (message.type) {
			case MessageType.NUMBER:
				write(ws, {'type':MessageType.RESPONSE_NUMBER,'data':latestBlock.index});
			break;
			case MessageType.RESPONSE_NUMBER:
				ws.block = message.data;
			break;
            case MessageType.QUERY_LATEST:
                write(ws, responseLatestMsg());
                break;
            case MessageType.QUERY_MASS:
                queryMass(ws,message.data);
                break;
            case MessageType.RESPONSE_BLOCKCHAIN:
                handleBlockchainResponse(message);
                break;
            case MessageType.MAKER:
				write(ws, {'type':MessageType.RESPONSE_MAKER,'data':makerIp});
			break;
			case MessageType.RESPONSE_MAKER:
				handleMakerResponse(message.data);
				console.log('Received message:' + data);
			break;
			case MessageType.ADDTX:
				peddingTransations.push(JSON.parse(message.data));
				console.log("peddingTransations:"+peddingTransations.length);
			break;
        }
    });
};

var errorHandler = (ws) => {
    var closeConnection = (ws) => {
        console.log('connection failed to peer: ' + ws.url);
        sockets.splice(sockets.indexOf(ws), 1);
    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
};


var NextBlock = (req) => {
    var previousBlock = latestBlock;
    var nextIndex = previousBlock.index + 1;
    var nextTimestamp = new Date().getTime();
    var nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, req.length);
    return new Block(nextIndex, previousBlock.hash, nextTimestamp, req,myip,nextHash);
};

var getMainBlockNumber = () => {
	if(sockets.length>0)
	{
		getMassBlock();
		checkMakerOnline();
		write(sockets[0],{'type':MessageType.MAKER});
		sockets.forEach((ws)=>{
			write(ws,{'type':MessageType.NUMBER});
		});
	}

	initialPeers.forEach((peer) => {
		if(peer==myip)return;
		let isfind=false;
		sockets.forEach((ws)=>{
			if(ipv6To4(ws._socket.remoteAddress)==peer)
			{
				isfind=true;
			}
		});
		if(!isfind)
		{
			var ws = new WebSocket("ws://"+peer+":6001");
			ws.on('open', () => onOpen(ws));
			ws.on('error', (err) => {});
		}
	
		});

};
var checkMakerOnline = () => {
	if(makerIp!="" && makerIp!=myip && initialPeers.includes(myip))
	{
		let isfind=false;
		sockets.forEach((ws)=>{
			if(ipv6To4(ws._socket.remoteAddress)==makerIp)
			{
				isfind=true;
			}
		});
		if(!isfind)
		{
			changeMaker();
		}
	}
};

var getMassBlock = () => {
	let maxblock=-1;
	sockets.forEach((ws)=>{
		if(ws.block>maxblock)
		{
			maxblock=ws.block;
		}
	});
	if(latestBlock.index<maxblock)
	{
		let maxws=[];
		sockets.forEach((ws)=>{
			if(ws.block==maxblock && initialPeers.includes(ipv6To4(ws._socket.remoteAddress)))
			{
				maxws.push(ws);
			}
		});
		if(maxws.length>0)
		{
			let index = Math.floor(Math.random()*maxws.length);
			write(maxws[index],{'type':MessageType.QUERY_MASS,"data":latestBlock.index});
		}
	}
};

var calculateHashForBlock = (block) => {
    return calculateHash(block.index, block.previousHash, block.timestamp, block.data);
};

var calculateHash = (index, previousHash, timestamp) => {
    return CryptoJS.SHA256(index + previousHash + timestamp).toString();
};

var isValidNewBlock = (newBlock, previousBlock) => {
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('invalid index');
        return false;
    } else if (previousBlock.hash !== newBlock.previousHash) {
        console.log('invalid previoushash');
        return false;
    } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log('invalid hash: ' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash);
        return false;
    }
    return true;
};


var queryMass = (ws,start) =>{
	dbo.collection("block").find({"index":{ $gt:start}}).limit(10).toArray(function(err, result) { 
		if (err) throw err;  
		if(result!=null)
		{
			write(ws,{'type': MessageType.RESPONSE_BLOCKCHAIN, 'data': result});
		}
	});
};

var responseLatestMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': [latestBlock]
});
var handleMakerResponse = (ip) => {
	if(makerIp != ip &&initialPeers.includes(ip))
	{
		makerIp = ip;
		if(ip==myip)
		{
			makerWs=null;
			setTimeout(changeMaker,300000);
		}
		else
		{
			sockets.forEach((ws)=>{
				if(ip==ipv6To4(ws._socket.remoteAddress))
				{
					makerWs=ws;
					makerWs.maker =true;
					console.log("change maker to ",ipv6To4(ws._socket.remoteAddress));
				}
				else
				{
					ws.maker =false;
				}
			});
		}
	}
	
};
var receivedBlocks=[];
var handleBlockchainResponse = (message) => {
	   receivedBlocks = message.data.sort((b1, b2) => (b1.index - b2.index));
	   addBlock(); 
};
var addBlock= () => {
	if(receivedBlocks.length==0){return;}
	var nBlock= receivedBlocks.shift();
	if(nBlock.index-latestBlock.index==1)
	{
			 dbo.collection("block").insertOne(nBlock,function(err, result) {
				 if (err) throw err;
				  console.log('block added: ' + JSON.stringify(nBlock));
				  latestBlock = nBlock;
				  addBlock();
			 });
	}
};

var write = (ws, message) => {
	try {
		ws.send(JSON.stringify(message));
	} catch (error) {
		console.log("send msg error");
	}
	
}
var broadcast = (message) => sockets.forEach(socket => write(socket, message));



var getip = () => {
	http.get("http://chain.wotrack.com/ip.php", function (res) {  
		res.on('data', function (data) {  
			var result = data.toString();
			console.log("my ip:",result);
			myip=result;
			if(myip==makerIp)
			{
				setTimeout(changeMaker,300000);
			}
		});  
	}).on("error", function (err) {  
		console.log("getip error");
	});  
}


var checkBlockStart=1;
var checkBlock =()=>{
	console.log("check block:",checkBlockStart);
	if(checkBlockStart>=latestBlock.index || latestBlock.index<2){
		return;
	}
	dbo.collection("block").find({"index":{ $gte:checkBlockStart}}).limit(51).toArray(function(err, result) { 
		if (err) throw err;  
		if(result!=null && result.length>0)
		{
			if(result[0].index==1)
			{
				if (calculateHashForBlock(result[0]) !== result[0].hash || result[0].transation[0].to!="system" || result[0].transation[0].amount!="210000000") {
					dbo.collection("block").deleteMany({},()=>{
						genesisBlock().then(function onFulfilled(nb){
							latestBlock = nb;
						});
					});
					return;
				}
			}
			let isfinderror=false;
			let tempBlocks = [result[0]];
			for (let i = 1; i < result.length; i++) {
				if (isValidNewBlock(result[i], tempBlocks[i - 1])) {
					tempBlocks.push(result[i]);
				} else {
					isfinderror=true;
					console.log("find error block: ",result[i].index);
					dbo.collection("block").deleteMany({"index":{$gte:result[i].index}},()=>{
						dbo.collection("block").findOne({},{sort:{'index': -1}},(err5, result5)=> { 
							if(result5!=null)
							{
								latestBlock = result5;
								console.log("block number is "+result5.index);
							}
						});
					});
					break;
				}
			}
			if(!isfinderror){checkBlockStart=result[result.length-1].index;}
		}
	});

};
var recheckBlock=()=>{
	if(checkBlockStart==latestBlock.index)
	{
		checkBlockStart=1;
	}
};

var genesisBlock=()=>{
	return new Promise(function (resolve, reject) {
			console.log('genesis');	
			var d={
				"from": "0",
				"to": "system",
				"amount": 210000000,
				"fee": 0,
				"data": "0x2534b94Da8a9ca6BaC906B339230b4427BC2772D"
			};
			var nextIndex = 1;
			var nextTimestamp = 1559318400000;
			var nextHash = calculateHash(nextIndex, "0x0", nextTimestamp, 1);
			var nBlock=new Block(nextIndex,"0x0", nextTimestamp, [d],"",nextHash);
		
			dbo.collection("block").insertOne(nBlock,function(err4, result4) {
				if (err4) throw err4;
				console.log('block added: ' + JSON.stringify(nBlock));
				resolve(nBlock);
			});
		}).catch(function onRejected(error){
			console.error(error);
		});
};

var initdb = () => {
	MongoClient.connect(url, {useNewUrlParser:true}, function(err, db) {
		if (err) throw err;  
		dbo = db.db("chain");
		console.log("mongodb connected");
		dbo.collection("block").countDocuments(function(err2, result2) { 
			if (result2==0) 
			{
				genesisBlock().then(function onFulfilled(nb){
					latestBlock = nb;
					connectToPeers();
					initHttpServer();
					initP2PServer();
				});
			}
			else 
			{
				dbo.collection("block").findOne({},{sort:{'index': -1}},function(err5, result5) { 
					if(result5!=null)
					{
						latestBlock = result5;
						console.log("block number is "+result5.index);
						connectToPeers();
						initHttpServer();
						initP2PServer();
					}
				});
			}
		});	
	});

}


getip();
setInterval(checkBlock,12000);
setInterval(recheckBlock,5*60*60*1000);
initdb();

