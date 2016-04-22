/*
    DLOA Payment Processor

    Handles payments for Alexandria.

*/
'use strict'
let blocktrail = require('blocktrail-sdk');
let http = require('http');
let querystring = require('querystring');
let fs = require('fs');

let configuration;
let API_KEY = "";
let API_SECRET = "";
let WALLET_NAME = "";
let WALLET_PASSWORD = "";
let USE_TESTNET = true;
let PORT = 11306;

const URL_RECEIVE = "/payproc/api/receive";
const URL_RECEIVED_BYADDRESS = "/payproc/api/getreceivedbyaddress";

const FWD_PAY_DELAY = 15 * 1000;  // 15 seconds

let client;
let payWallet;
let forwardAddressMap = new Map(); // Key: source address, Value: forwarding destination address
let addressRecvAmtMap = new Map(); // Key: temporary receive address, Value: payment amount in Satoshis
let temporaryAddressMap = new Map(); // Key: forward to receive address, Value: temporary receive address

let server;
let continueForwardingPayments = true;  // Use this flag to stop forwarding
let forwardPaymentsTimeout;

// Configure and start server
configure(runServer);


function configure(configReady) {


	fs.readFile('payproc.conf', 'utf8', function(err, contents) {
		if (err) {
			console.error(err);
			return false;
		}

    	configuration = JSON.parse(contents);

    	API_KEY = configuration.config.API_KEY;
    	API_SECRET = configuration.config.API_SECRET;
    	WALLET_NAME = configuration.config.WALLET_NAME;
    	WALLET_PASSWORD = configuration.config.WALLET_PASSWORD;
    	USE_TESTNET = configuration.config.USE_TESTNET;
    	PORT = configuration.config.PORT;

    	configReady();
	});
}

function runServer() {
	client = blocktrail.BlocktrailSDK( {
		apiKey : API_KEY,
		apiSecret : API_SECRET,
		testnet : USE_TESTNET
	});
	client.initWallet(WALLET_NAME, WALLET_PASSWORD, setPayWallet);

	// Create a server
	server = http.createServer(handleRequest);

	// Lets start our server
	server.listen(PORT, function(){
	    console.log("Server listening on port, %s.", PORT);
	});

	// Start funds forward process
	forwardPaymentsTimeout = setTimeout(forwardPayments, FWD_PAY_DELAY);
}

function setPayWallet(err, wallet) {
	if (err) {
		return console.log('initWallet ERR', err);
	} else {
		console.log('Wallet', WALLET_NAME, 'initialized.');
	}
	payWallet = wallet;
	console.log("Wallet initialized.");	
}

function payWalletBalance(balanceCb) {
    if (payWallet == undefined) {
    	setTimeout(payWalletBalance, 250);
    	return;
    } 

	payWallet.getBalance().then(function(balance) {
	        console.log('Balance: ', blocktrail.toBTC(balance[0]));
	        balanceCb(blocktrail.toBTC(balance[0]));
	    },
	    handleError);
	
}


function addressBalance(address, balanceCb) {
	if (client == undefined) {
		setTimeout(addressBalance(address, balanceCb), 250);
	}

	client.address(address).then(function(address) {
		console.log("Balance:", address.balance);
		balanceCb(address.balance);
	},
	handleError);
}

function addressUnconfirmedReceived(address, unconfRecvd) {
	if (client == undefined) {
		setTimeout(addressUnconfirmedReceived(address, unconfRecvd), 250);
	}

	client.address(address).then(function(address) {
		console.log("Unconfirmed: ", address.unconfirmed_received);
		balanceCb(address.unconfirmed_received);
	},
	handleError);
}

function mapAddressForwarding(sourceAddress, destAddress) {
	forwardAddressMap.set(sourceAddress, destAddress);
}

function mapTemporaryAddress(receiveAddress, tempAddress) {
	temporaryAddressMap.set(receiveAddress, tempAddress);
}

function mapTempAddressRecvAmount(tempAddress, amountSatoshis) {
	addressRecvAmtMap.set(tempAddress, amountSatoshis);
}

function handleError(err) {
    console.error(err);
}

function receivePayment(recvAddress, amountBTC, addressCb) {
	if (payWallet == undefined) {
		setTimeout(receivePayment(recvAddress, amountBTC, tempAddress), 250);
		return;
	}

	payWallet.getNewAddress().then(function(address, path) {
		console.log('new address', address);
		mapAddressForwarding(address, recvAddress);
		mapTemporaryAddress(recvAddress, address);
		mapTempAddressRecvAmount(address, blocktrail.toSatoshi(amountBTC));
		addressCb(address);
	},
	handleError);
}

// TODO: Implement forward payments like https://gist.github.com/rubensayshi/35e45d4a843a8f9409e2
function forwardPayments() {
	if (!continueForwardingPayments) {
		clearTimeout(forwardPaymentsTimeout);
		continueForwardingPayments = false;
		return false;
	}

	console.log("+++ Scanning payments to forward (TODO: Implement me!) +++");

	forwardPaymentsTimeout = setTimeout(forwardPayments, FWD_PAY_DELAY)
}

// Main request handler
function handleRequest(request, response){
	if (request.url.indexOf(URL_RECEIVE) == 0) {
		handleReceiveCreateAddress(request, response);
	} else if (request.url.indexOf(URL_RECEIVED_BYADDRESS) == 0) {
		handleGetReceivedByAddress(request, response);
	} else {
		response.statusCode = 404;
		response.statusMessage = "Not found";
		response.end("Error");
	}
    
}

function handleReceiveCreateAddress(request, response) {
    let query = request.url.substring(request.url.indexOf("?")+1);
    let param = querystring.parse(query);
    receivePayment(param.address, param.amount, function(tempAddress) {
        response.end(tempAddress[0]);
    });

}

function handleGetReceivedByAddress(request, response) {
	let recvAddress = request.url.substring(URL_RECEIVED_BYADDRESS.length+1);
	addressUnconfirmedReceived(recvAddress, function(balanceSatoshis) {
		response.end(blocktrail.toBTC(balanceSatoshis));
	}); 
}
