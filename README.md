# dloa-payproc Alexandria Payment Processor

## Installation

**Install dependencies**

```
npm install blocktrail-sdk
```

**Copy the payproc.sample.conf file to payproc.conf and edit it.**

```
$ cp payproc.sample.conf payproc.conf
$ vi payproc.conf
{
	"config": {
		"API_KEY": "blocktrail api key",
		"API_SECRET": "blocktrail secret",
		"WALLET_NAME": "the wallet name",
		"WALLET_PASSWORD": "the wallet password",
		"USE_TESTNET": true,
		"PORT": 11306
	}
}
```

Adjust the settings to match your Blocktrail information and the server's port number.

**Run the server**

```
node payproc.js
```

## Usage

### /payproc/api/receive

To generate a receive address for payments, use /payproc/api/receive.

```
$ curl "http://localhost:11306/payproc/api/receive?address=2N4ajxiM1xHc83mehV2LTXk2Z65TAfc9MhX&amount=0.432"
{"input_address":"2N6dDdHGx24ss6AoAqjx8gnc2JQpETe1mBp"}
```

Parameters:

**address** _Address to receive coins_

**amount** _Amount to send to address in BTC_

Return:

**temporary address** _The temporary address that can be shown to the buyer._

### /payproc/api/getreceivedbyaddress

To check the total amount of the unconfirmed balance of the given BTC address:

```
$ curl "http://localhost:11306/payproc/api/getreceivedbyaddress/2N4ajxiM1xHc83mehV2LTXk2Z65TAfc9MhX"
0.00000000
```

Path Parameter:

/payproc/api/getreceivedbyaddress/**[BTC ADDRESS]**  _The temporary payment address to monitor._

Return:

The unconfirmed balance in BTC.