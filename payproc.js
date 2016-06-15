/*
    DLOA Payment Processor

    Handles payments for Alexandria.

*/
/* jshint esversion: 6 */
/* jshint node: true */
"use strict";
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
let DB_FILE = "payproc.db";
let FORWARD_BAL_THRESHOLD = 70000;    //TODO: Set this value to $0.50 worth of Satoshis, query market value

let PYMT_ADDR_ROTATION_IMPLEMENTED = false;

const URL_RECEIVE = "/payproc/receive";
const URL_RECEIVED_BYADDRESS = "/payproc/getreceivedbyaddress";
const URL_PING = "/payproc/ping";

const FWD_PAY_DELAY = 10 * 60 * 1000; // 10 minutes
const STATUS_CHECKED_OUT = 0;
const STATUS_CHECKED_IN = 1;
const FORWARDED_FALSE = 0;
const FORWARDED_TRUE = 1;

let client;
let payWallet;
let forwardAddressMap = new Map(); // Key: source address, Value: forwarding destination address
let addressRecvAmtMap = new Map(); // Key: temporary receive address, Value: payment amount in Satoshis
let temporaryAddressMap = new Map(); // Key: forward to receive address, Value: temporary receive address

let server;
let continueForwardingPayments = true; // Use this flag to stop forwarding
let forwardPaymentsTimeout;
let payprocDb;

// Configure and start server
configure(runServer);

/**
 * Configures settings for payproc server.
 * 
 * @param  {function} Function to invoke after reading configuration.
 *
 */
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
		DB_FILE = configuration.config.DB_FILE;
        FORWARD_BAL_THRESHOLD = configuration.config.FORWARD_BAL_THRESHOLD;

		configReady();
	});
}

function runServer() {
	client = blocktrail.BlocktrailSDK({
		apiKey: API_KEY,
		apiSecret: API_SECRET,
		testnet: USE_TESTNET
	});
	client.initWallet(WALLET_NAME, WALLET_PASSWORD, setPayWallet);

	// Setup database
	dbSetup();

	// Create a server
	server = http.createServer(handleRequest);

	// Lets start our server
	server.listen(PORT, function() {
		console.log("Server listening on port, %s.", PORT);
	});

	// Start funds forward process
	forwardPaymentsTimeout = setTimeout(forwardPayments, FWD_PAY_DELAY);
}

function dbSetup() {
	let fs = require("fs");
	let exists = fs.existsSync(DB_FILE);

	if (!exists) {
		DB_FILE = "payproc.db";
		console.log("Creating DB file, " + DB_FILE + ".");
		fs.openSync(DB_FILE, "w");
	}

	let sqlite3 = require("sqlite3").verbose();
	payprocDb = new sqlite3.Database(DB_FILE);

	payprocDb.serialize(function() {
		if (!exists) {
			payprocDb.run("CREATE TABLE PaymentAddress (destinationAddress TEXT, paymentAddress TEXT, targetBalance INTEGER, payableBalance INTEGER, status INTEGER, forwarded INTEGER)");
		}
	});
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
	if (payWallet === undefined) {
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
	if (client === undefined) {
		setTimeout(addressBalance(address, balanceCb), 250);
	}

	client.address(address).then(function(address) {
			console.log("Balance:", address.balance);
			balanceCb(address.balance);
		},
		handleError);
}

function addressUnconfirmedReceived(address, unconfRecvd) {
	if (client === undefined) {
		setTimeout(addressUnconfirmedReceived(address, unconfRecvd), 250);
	}

	client.address(address).then(function(address) {
			console.log("Unconfirmed: ", address.unconfirmed_received);
			unconfRecvd(address.unconfirmed_received);
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
	if (payWallet === undefined) {
		setTimeout(receivePayment(recvAddress, amountBTC, addressCb), 250);
		return;
	}
    let amountSatoshis = blocktrail.toSatoshi(amountBTC);

    // Attempt to retrieve temporary payment address from repository
 	retrieveNextPaymentAddress(recvAddress, amountSatoshis, addressCb);

}

// Parameters
//     recvAddress    Bitcoin address of publisher (or final target)
//     pymtAmt        Excepted payment amount in Satoshis
//     pymtAddrCb     Callback function invoked with pymyAddrCb(pymtAddr)
//
//     TODO: Temporarily, payment addresses will be used only once. Thus, status will also be STATUS_CHECKED_OUT until implementation of
//     rotating payment addresses is complete.     
function retrieveNextPaymentAddress(recvAddress, pymtAmt, pymtAddrCb) {


	if (PYMT_ADDR_ROTATION_IMPLEMENTED) {

		let stmt = payprocDb.prepare("SELECT paymentAddress, targetBalance FROM PaymentAddress WHERE destinationAddress = ? AND status = ?");

		stmt.get(recvAddress, STATUS_CHECKED_IN, function(err, row) {
			let pymtAddr;
			let targetBal = 0;           // In Satoshis

			// Handle no available payment address to use
			if (row === undefined) {
				payWallet.getNewAddress().then(function(address, path) {
					console.log("Created new payment address, " + address + ".");
					pymtAddr = address;
					targetBal += pymtAmt;
					let insertStmt = payprocDb.prepare("INSERT INTO PaymentAddress (destinationAddress, paymentAddress, status, targetBalance, payableBalance, forwarded) VALUES (?, ?, ?, ?, ?, ?, ?)");
					insertStmt.run(recvAddress, pymtAddr, STATUS_CHECKED_OUT, targetBal, pymtAmt, pymtAmt, FORWARDED_FALSE);
					insertStmt.finalize();

				});
			} else {

				pymtAddr = row.paymentAddress;

				addressBalance(pymtAddr, function(confirmedBal) {
					targetBal = confirmedBal;
					targetBal += pymtAmt;

					// TODO: Test whether this could setup a race condition, counting on Node.js serving http single threaded.
					let updateStmt = payprocDb.prepare("UPDATE PaymentAddress SET status = ?, targetBalance = ? WHERE paymentAddress = ?");
					updateStmt.run(STATUS_CHECKED_OUT, targetBal, pymtAddr);
					updateStmt.finalize();
				});
				pymtAddrCb(pymtAddr);
			}
			
		});

	} else {

			let pymtAddr;
			let targetBal = 0;           // In Satoshis

			payWallet.getNewAddress().then(function(address, path) {
				console.log("Created new payment address, " + address + ".");
				pymtAddr = address;
				targetBal += pymtAmt;
				let insertStmt = payprocDb.prepare("INSERT INTO PaymentAddress (destinationAddress, paymentAddress, status, targetBalance, payableBalance) VALUES (?, ?, ?, ?, ?, ?,?)");
				insertStmt.run(recvAddress, pymtAddr, STATUS_CHECKED_OUT, targetBal, pymtAmt, pymtAmt, FORWARDED_FALSE);
				insertStmt.finalize();
				pymtAddrCb(pymtAddr);
			});	
	}

}

function addNewPaymentAddress(recvAddress, pmtAddress, targetAmtBTC) {
	let targetSatoshis = blocktrail.toSatoshi(targetAmtBTC);
	let stmt = db.prepare("INSERT INTO PaymentAddress (destinationAddress, paymentAddress, status, startUnconfBal, targetBalance) VALUES (?, ?, ?, ?, ?)");
	stmt.run(recvAddress, pmtAddress, STATUS_CHECKED_IN, 0, targetSatoshis);
	stmt.finalize();
}

// TODO: Implement forward payments like https://gist.github.com/rubensayshi/35e45d4a843a8f9409e2
function forwardPayments() {
	if (!continueForwardingPayments) {
		clearTimeout(forwardPaymentsTimeout);
		continueForwardingPayments = false;
		return false;
	}

	/*
	
	for each destAddress

		pymtRecvSum = 0

		for each pymtAddr in destAddress
			get pymtAddr.balance
			if pymtAddr.balance >= payableBalance
			    set payableBalance = 0
			    set forwarded = FORWARDED_TRUE
			    pymtRecvSum += pymtAddr.balance
			else
				set payableBalance =  (payableBalance - pymtAddr.balance <= 0) ? 0 : payableBalance - pymtAddr.balance

			
		if pymtRecvSum > FORWARD_BAL_THRESHOLD
		    wallet.pay pymtRecvSum to destAddress


	 */


	forwardPaymentsTimeout = setTimeout(forwardPayments, FWD_PAY_DELAY);
}

// Main request handler
function handleRequest(request, response) {
	console.log(request.url);
	if (request.url.indexOf(URL_RECEIVE) === 0) {
		handleReceiveCreateAddress(request, response);
	} else if (request.url.indexOf(URL_RECEIVED_BYADDRESS) === 0) {
		handleGetReceivedByAddress(request, response);
	} else if (request.url.indexOf(URL_PING)) {
		handlePing(request, response);
	} else {
		response.statusCode = 404;
		response.statusMessage = "Not found";
		response.end("Error");
	}

}

function handleReceiveCreateAddress(request, response) {
	let query = request.url.substring(request.url.indexOf("?") + 1);
	let param = querystring.parse(query);
	receivePayment(param.address, param.amount, function(tempAddress) {
		var addressObject = {
			input_address: tempAddress[0]
		};
		var jsonData = JSON.stringify(addressObject);
		response.setHeader('Access-Control-Allow-Origin', '*');
		response.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
		response.setHeader('Content-Type', 'application/json');
		response.statusCode = 200;
		response.write(jsonData);
		response.end();
	});

}

function handleGetReceivedByAddress(request, response) {
	let recvAddress = request.url.substring(URL_RECEIVED_BYADDRESS.length + 1);
	addressUnconfirmedReceived(recvAddress, function(balanceSatoshis) {
		console.log(balanceSatoshis);
		response.setHeader('Access-Control-Allow-Origin', '*');
		response.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
		response.setHeader('Content-Type', 'text/plain');
		response.statusCode = 200;
		response.end(blocktrail.toBTC(balanceSatoshis));
	});
}

function handlePing(request, response) {
	console.log("Received ping from " + request.socket.remoteAddress);
		response.setHeader('Access-Control-Allow-Origin', '*');
		response.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
		response.setHeader('Content-Type', 'text/plain');
		response.statusCode = 200;
		response.end("ALIVE");
}

/*
Deprecated code - temporarily keep around for reference

	payWallet.getNewAddress().then(function(address, path) {
			console.log('new address', address);
			mapAddressForwarding(address, recvAddress);
			mapTemporaryAddress(recvAddress, address);
			mapTempAddressRecvAmount(address, amountSatoshis);
			addressCb(address);
		},
		handleError);




 */
