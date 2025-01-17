/* eslint-disable new-cap */
/* global dw, session, empty */

'use strict';

var server = require('server');

var stripePaymentsHelper = require('*/cartridge/scripts/stripe/helpers/controllers/stripePaymentsHelper');
var csrfProtection = require('*/cartridge/scripts/middleware/csrf');

/**
 * An entry point to handle returns from alternative payment methods.
 */

server.get('HandleAPM', function (req, res, next) {
    var redirectUrl = stripePaymentsHelper.HandleAPM(true);
    res.redirect(redirectUrl);
    next();
});

/**
 * Get Stripe Order Items
 */
server.get('GetStripeOrderItems', function (req, res, next) {
    var BasketMgr = require('dw/order/BasketMgr');
    var basket = BasketMgr.getCurrentBasket();

    var stripeOrderDetails = basket ? require('*/cartridge/scripts/stripe/helpers/checkoutHelper').getStripeOrderDetails(basket) : null;

    res.json({
        amount: stripeOrderDetails ? stripeOrderDetails.amount : [],
        orderItems: stripeOrderDetails ? stripeOrderDetails.order_items : [],
        currency: stripeOrderDetails ? stripeOrderDetails.currency : null,
        purchase_country: stripeOrderDetails ? stripeOrderDetails.purchase_country : null,
        order_shipping: stripeOrderDetails ? stripeOrderDetails.order_shipping : [],
        shipping_first_name: stripeOrderDetails ? stripeOrderDetails.shipping_first_name : null,
        shipping_last_name: stripeOrderDetails ? stripeOrderDetails.shipping_last_name : null
    });

    next();
});

/**
 * Entry point for handling payment intent creation for APMs.
 */
server.post('BeforePaymentSubmit', csrfProtection.validateAjaxRequest, function (req, res, next) {
    var type = req.form.type;
    var params = {};

    if (req.form.orderid) {
        params.orderid = req.form.orderid;
    }

    var responsePayload = stripePaymentsHelper.BeforePaymentSubmit(type, params);
    res.json(responsePayload);

    next();
});

/**
 * Get Customer Email
 */
server.get('GetCustomerEmail', function (req, res, next) {
    var BasketMgr = require('dw/order/BasketMgr');
    var basket = BasketMgr.getCurrentBasket();

    var email = basket ? basket.getCustomerEmail() : '';

    res.json({
        email: email
    });

    next();
});

/**
 * Entry point for handling writing errors to Stripe Logger called as an AJAX request
 */
server.post('LogStripeErrorMessage', csrfProtection.validateAjaxRequest, function (req, res, next) {
    var msg = req.form.msg;

    stripePaymentsHelper.LogStripeErrorMessage(msg);

    res.json({
        success: true
    });

    next();
});

/**
 * Entry point for handling writing errors to Stripe Logger called as an AJAX request
 */
server.post('FailOrder', csrfProtection.validateAjaxRequest, function (req, res, next) {
    stripePaymentsHelper.FailOrder();

    res.json({
        success: true
    });

    next();
});

/**
 * Entry point for handling CardPaymentSubmitOrder
 */
server.post('CardPaymentSubmitOrder', csrfProtection.validateAjaxRequest, function (req, res, next) {
    /*
     * I. Create SFCC Order
     */

    var BasketMgr = require('dw/order/BasketMgr');
    var OrderMgr = require('dw/order/OrderMgr');
    var Resource = require('dw/web/Resource');
    var Transaction = require('dw/system/Transaction');
    var URLUtils = require('dw/web/URLUtils');
    var basketCalculationHelpers = require('*/cartridge/scripts/helpers/basketCalculationHelpers');
    var hooksHelper = require('*/cartridge/scripts/helpers/hooks');
    var COHelpers = require('*/cartridge/scripts/checkout/checkoutHelpers');
    var validationHelpers = require('*/cartridge/scripts/helpers/basketValidationHelpers');
    var Order = require('dw/order/Order');
    var checkoutHelper = require('*/cartridge/scripts/stripe/helpers/checkoutHelper');

    session.privacy.stripeOrderNumber = null;
    delete session.privacy.stripeOrderNumber;

    var currentBasket = BasketMgr.getCurrentBasket();

    if (!currentBasket) {
        res.json({
            error: true,
            cartError: true,
            fieldErrors: [],
            serverErrors: [],
            redirectUrl: URLUtils.url('Cart-Show').toString()
        });
        stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder: Error Create SFCC Order: Empty Basket');
        return next();
    }

    if (currentBasket.custom.stripePaymentIntentID) {
        Transaction.wrap(function () {
            currentBasket.custom.stripePaymentIntentID = null;
        });
    }

    var cardPaymentInstrument = checkoutHelper.getStripePaymentInstrument(currentBasket);
    if (cardPaymentInstrument && cardPaymentInstrument.paymentTransaction && cardPaymentInstrument.paymentTransaction.getTransactionID()) {
        Transaction.wrap(function () {
            cardPaymentInstrument.paymentTransaction.setTransactionID(null);
        });
    }

    var validatedProducts = validationHelpers.validateProducts(currentBasket);
    if (validatedProducts.error) {
        res.json({
            error: true,
            cartError: true,
            fieldErrors: [],
            serverErrors: [],
            redirectUrl: URLUtils.url('Cart-Show').toString()
        });
        stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder: Error Create SFCC Order: Error validationHelpers.validateProducts');
        return next();
    }

    if (req.session.privacyCache.get('fraudDetectionStatus')) {
        res.json({
            error: true,
            cartError: true,
            redirectUrl: URLUtils.url('Error-ErrorCode', 'err', '01').toString(),
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder Create SFCC Order: Error on fraudDetectionStatus');
        return next();
    }

    var validationOrderStatus = hooksHelper('app.validate.order', 'validateOrder', currentBasket, require('*/cartridge/scripts/hooks/validateOrder').validateOrder);
    if (validationOrderStatus.error) {
        res.json({
            error: true,
            errorMessage: validationOrderStatus.message
        });
        stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder Create SFCC Order: Error on app.validate.order');
        return next();
    }

    // Check to make sure there is a shipping address
    if (currentBasket.defaultShipment.shippingAddress === null) {
        res.json({
            error: true,
            errorStage: {
                stage: 'shipping',
                step: 'address'
            },
            errorMessage: Resource.msg('error.no.shipping.address', 'checkout', null)
        });
        stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder Create SFCC Order: Error on currentBasket.defaultShipment.shippingAddress === null');
        return next();
    }

    // Check to make sure billing address exists
    if (!currentBasket.billingAddress) {
        res.json({
            error: true,
            errorStage: {
                stage: 'payment',
                step: 'billingAddress'
            },
            errorMessage: Resource.msg('error.no.billing.address', 'checkout', null)
        });
        stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder Create SFCC Order: Error on !currentBasket.billingAddress');
        return next();
    }

    // Calculate the basket
    Transaction.wrap(function () {
        basketCalculationHelpers.calculateTotals(currentBasket);
    });

    // Re-validates existing payment instruments
    var validPayment = COHelpers.validatePayment(req, currentBasket);
    if (validPayment.error) {
        res.json({
            error: true,
            errorStage: {
                stage: 'payment',
                step: 'paymentInstrument'
            },
            errorMessage: Resource.msg('error.payment.not.valid', 'checkout', null)
        });
        stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder Create SFCC Order: Error on COHelpers.validatePayment');
        return next();
    }

    // Re-calculate the payments.
    var calculatedPaymentTransactionTotal = COHelpers.calculatePaymentTransaction(currentBasket);
    if (calculatedPaymentTransactionTotal.error) {
        res.json({
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder Create SFCC Order: Error on calculatedPaymentTransactionTotal.error');
        return next();
    }

    // Creates a new order.
    var order = COHelpers.createOrder(currentBasket);
    if (!order) {
        res.json({
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder Create SFCC Order: Error on COHelpers.createOrder');
        return next();
    }

    session.privacy.stripeOrderNumber = order.orderNo;

    // Handles payment authorization
    var handlePaymentResult = COHelpers.handlePayments(order, order.orderNo);

    // Handle custom processing post authorization
    var options = {
        req: req,
        res: res
    };
    var postAuthCustomizations = hooksHelper('app.post.auth', 'postAuthorization', handlePaymentResult, order, options, require('*/cartridge/scripts/hooks/postAuthorizationHandling').postAuthorization);
    if (postAuthCustomizations && Object.prototype.hasOwnProperty.call(postAuthCustomizations, 'error')) {
        res.json(postAuthCustomizations);
        stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder Create SFCC Order: Error on postAuthCustomizations');
        return next();
    }

    if (handlePaymentResult.error) {
        res.json({
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    var fraudDetectionStatus = hooksHelper('app.fraud.detection', 'fraudDetection', currentBasket, require('*/cartridge/scripts/hooks/fraudDetection').fraudDetection);
    if (fraudDetectionStatus.status === 'fail') {
        Transaction.wrap(function () {
            order.addNote('Order Failed Reason', 'fraudDetectionStatus.status === fail');
            OrderMgr.failOrder(order, true);
        });

        // fraud detection failed
        req.session.privacyCache.set('fraudDetectionStatus', true);

        res.json({
            error: true,
            cartError: true,
            redirectUrl: URLUtils.url('Error-ErrorCode', 'err', fraudDetectionStatus.errorCode).toString(),
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder Create SFCC Order: Error on fraudDetectionStatus.status');
        return next();
    }

    /*
     * II. Create Payment Intent
     */
    var stripePaymentInstrument = checkoutHelper.getStripePaymentInstrument(order);

    if (!stripePaymentInstrument || stripePaymentInstrument.paymentMethod !== 'CREDIT_CARD') {
        res.json({
            error: true,
            cartError: true,
            redirectUrl: URLUtils.url('Error-ErrorCode', 'err', fraudDetectionStatus.errorCode).toString(),
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder Create Payment Intent: Error on paymentMethod is CREDIT_CARD check');
        Transaction.wrap(function () {
            order.addNote('Stripe Error', 'Try to process Order as CREDIT_CARD for a different payment method');
        });
        return next();
    }

    // So far, we have created an SFCC order and return order datails to be used for Checkout Summary Page
    var responsePayload = {
        error: false,
        orderID: order.orderNo,
        orderToken: order.orderToken,
        continueUrl: URLUtils.url('Order-Confirm').toString()
    };

    var paymentIntent = null;
    try {
        paymentIntent = checkoutHelper.createPaymentIntent(stripePaymentInstrument);
    } catch (e) {
        Transaction.wrap(function () {
            var noteMessage = e.message.length > 1000 ? e.message.substring(0, 1000) : e.message;
            order.addNote('Error When Create Stripe Payment Intent', noteMessage);
            OrderMgr.failOrder(order, true);
        });

        responsePayload.error = true;
        responsePayload.errorMessage = Resource.msg('error.technical', 'checkout', null);

        res.json(responsePayload);

        return next();
    }
    var stripeChargeCapture = dw.system.Site.getCurrent().getCustomPreferenceValue('stripeChargeCapture');
    var stripeAccountId = dw.system.Site.getCurrent().getCustomPreferenceValue('stripeAccountId');
    var stripeAccountType = dw.system.Site.getCurrent().getCustomPreferenceValue('stripeAccountType');

    Transaction.wrap(function () {
        stripePaymentInstrument.paymentTransaction.setTransactionID(paymentIntent.id);
        stripePaymentInstrument.paymentTransaction.setType(stripeChargeCapture ? dw.order.PaymentTransaction.TYPE_CAPTURE : dw.order.PaymentTransaction.TYPE_AUTH);

        if (!empty(stripeAccountId)) {
            stripePaymentInstrument.paymentTransaction.custom.stripeAccountId = stripeAccountId;
        }

        if (!empty(stripeAccountType) && 'value' in stripeAccountType && !empty(stripeAccountType.value)) {
            stripePaymentInstrument.paymentTransaction.custom.stripeAccountType = stripeAccountType.value;
        }
    });

    Transaction.wrap(function () {
        if (paymentIntent.review) {
            order.custom.stripeIsPaymentIntentInReview = true;
        }
        order.custom.stripePaymentIntentID = paymentIntent.id;
        order.custom.stripePaymentSourceID = '';

        if (paymentIntent.charges && paymentIntent.charges.data && paymentIntent.charges.data.length > 0 && paymentIntent.charges.data[0].outcome) {
            order.custom.stripeRiskLevel = paymentIntent.charges.data[0].outcome.risk_level;
            order.custom.stripeRiskScore = paymentIntent.charges.data[0].outcome.risk_score;
        }
    });

    if (paymentIntent.status === 'requires_capture' && !stripeChargeCapture) {
        // The payment requires capture which will be made later
        try {
            Transaction.wrap(function () {
                var placeOrderStatus = OrderMgr.placeOrder(order);
                if (placeOrderStatus.isError()) {
                    throw new Error();
                }

                order.setConfirmationStatus(Order.CONFIRMATION_STATUS_CONFIRMED);
                order.setExportStatus(Order.EXPORT_STATUS_READY);

                session.privacy.stripeOrderNumber = null;
                delete session.privacy.stripeOrderNumber;
            });
            COHelpers.sendConfirmationEmail(order, req.locale.id);
            responsePayload.success = true;
        } catch (e) {
            stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder Create Payment Intent: Error on paymentIntent.status === requires_capture && !stripeChargeCapture');
            responsePayload.error = true;
        }
    } else if (paymentIntent.status === 'requires_action' || paymentIntent.status === 'requires_source_action') {
        // Tell the client to handle the action
        Transaction.wrap(function () {
            order.addNote('Stripe 3DS', 'requires_action: Pending');
        });
        responsePayload.requires_action = true;
        responsePayload.payment_intent_client_secret = paymentIntent.client_secret;
    } else if (paymentIntent.status === 'succeeded' || paymentIntent.status === 'requires_confirmation') {
        // The payment didn’t need any additional actions and completed!
        // Handle post-payment fulfilment
        try {
            Transaction.wrap(function () {
                var placeOrderStatus = OrderMgr.placeOrder(order);
                if (placeOrderStatus.isError()) {
                    throw new Error();
                }

                order.setConfirmationStatus(Order.CONFIRMATION_STATUS_CONFIRMED);
                order.setExportStatus(Order.EXPORT_STATUS_READY);

                if (stripeChargeCapture) {
                    order.setPaymentStatus(Order.PAYMENT_STATUS_PAID);
                }

                session.privacy.stripeOrderNumber = null;
                delete session.privacy.stripeOrderNumber;
            });
            COHelpers.sendConfirmationEmail(order, req.locale.id);
            responsePayload.success = true;
        } catch (e) {
            stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder Create Payment Intent: Error on paymentIntent.status === succeeded || paymentIntent.status === requires_confirmation');
            responsePayload.error = true;
        }
    } else {
        // Invalid status
        Transaction.wrap(function () {
            order.addNote('Order Failed Reason', 'Invalid payment intent status: ' + paymentIntent.status);
            OrderMgr.failOrder(order, true);
        });
        stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder Create Payment Intent: Error on invalid payment intent status: ' + paymentIntent.status);
        Transaction.wrap(function () {
            order.addNote('Stripe Error', 'StripePayments.CardPaymentSubmitOrder Create Payment Intent: Error on invalid payment intent status: ' + paymentIntent.status);
        });
        responsePayload.error = true;
        responsePayload.errorMessage = Resource.msg('error.technical', 'checkout', null);
    }

    res.json(responsePayload);

    return next();
});

/**
 * Entry point for handling payment intent confirmation when requires action and confirmation AJAX calls.
 */
server.post('CardPaymentHandleRequiresAction', csrfProtection.validateAjaxRequest, function (req, res, next) {
    var responsePayload;
    var OrderMgr = require('dw/order/OrderMgr');
    var checkoutHelper = require('*/cartridge/scripts/stripe/helpers/checkoutHelper');
    var stripePaymentInstrument;
    var Transaction = require('dw/system/Transaction');
    var Order = require('dw/order/Order');
    var paymentIntent;
    var paymentIntentId;
    var stripeChargeCapture = dw.system.Site.getCurrent().getCustomPreferenceValue('stripeChargeCapture');
    var stripeAccountId = dw.system.Site.getCurrent().getCustomPreferenceValue('stripeAccountId');
    var stripeAccountType = dw.system.Site.getCurrent().getCustomPreferenceValue('stripeAccountType');
    var COHelpers = require('*/cartridge/scripts/checkout/checkoutHelpers');

    try {
        /*
         * Handle the case when SFCC order is being created before making call to Stripe to create a Payment Intent and confirm the payment
         */
        if (!session || !session.privacy || !session.privacy.stripeOrderNumber) {
            responsePayload = {
                error: true
            };
            res.json(responsePayload);
            return next();
        }

        var order = OrderMgr.getOrder(session.privacy.stripeOrderNumber);
        if (!order) {
            responsePayload = {
                error: true
            };
            res.json(responsePayload);
            return next();
        }

        stripePaymentInstrument = checkoutHelper.getStripePaymentInstrument(order);

        if (!stripePaymentInstrument || stripePaymentInstrument.paymentMethod !== 'CREDIT_CARD') {
            responsePayload = {
                error: true
            };
            res.json(responsePayload);
            return next();
        }

        /**
         * I. Confirms the payment intent
         */
        paymentIntentId = (stripePaymentInstrument.paymentTransaction)
            ? stripePaymentInstrument.paymentTransaction.getTransactionID() : null;
        if (paymentIntentId) {
            paymentIntent = checkoutHelper.confirmPaymentIntent(paymentIntentId, stripePaymentInstrument);
        } else {
            paymentIntent = checkoutHelper.createPaymentIntent(stripePaymentInstrument);

            Transaction.wrap(function () {
                stripePaymentInstrument.paymentTransaction.setTransactionID(paymentIntent.id);
                stripePaymentInstrument.paymentTransaction.setType(stripeChargeCapture ? dw.order.PaymentTransaction.TYPE_CAPTURE : dw.order.PaymentTransaction.TYPE_AUTH);

                if (!empty(stripeAccountId)) {
                    stripePaymentInstrument.paymentTransaction.custom.stripeAccountId = stripeAccountId;
                }

                if (!empty(stripeAccountType) && 'value' in stripeAccountType && !empty(stripeAccountType.value)) {
                    stripePaymentInstrument.paymentTransaction.custom.stripeAccountType = stripeAccountType.value;
                }
            });
        }

        Transaction.wrap(function () {
            if (paymentIntent.review) {
                order.custom.stripeIsPaymentIntentInReview = true;
            }
            order.custom.stripePaymentIntentID = paymentIntent.id;
            order.custom.stripePaymentSourceID = '';

            if (paymentIntent.charges && paymentIntent.charges.data && paymentIntent.charges.data.length > 0 && paymentIntent.charges.data[0].outcome) {
                order.custom.stripeRiskLevel = paymentIntent.charges.data[0].outcome.risk_level;
                order.custom.stripeRiskScore = paymentIntent.charges.data[0].outcome.risk_score;
            }
        });

        if (paymentIntent.status === 'requires_capture' && !stripeChargeCapture) {
            // The payment requires capture which will be made later
            try {
                Transaction.wrap(function () {
                    order.addNote('Stripe 3DS', 'requires_action: Confirmed');
                    var placeOrderStatus = OrderMgr.placeOrder(order);
                    if (placeOrderStatus.isError()) {
                        throw new Error();
                    }

                    order.setConfirmationStatus(Order.CONFIRMATION_STATUS_CONFIRMED);
                    order.setExportStatus(Order.EXPORT_STATUS_READY);

                    session.privacy.stripeOrderNumber = null;
                    delete session.privacy.stripeOrderNumber;
                });
                COHelpers.sendConfirmationEmail(order, req.locale.id);
                responsePayload.success = true;
            } catch (e) {
                stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder Create Payment Intent: Error on paymentIntent.status === requires_capture && !stripeChargeCapture');
                responsePayload.error = true;
            }
        } else if (paymentIntent.status === 'requires_action' || paymentIntent.status === 'requires_source_action') {
            Transaction.wrap(function () {
                order.addNote('Stripe 3DS', 'requires_action: Pending');
            });
            // Tell the client to handle the action
            responsePayload.requires_action = true;
            responsePayload.payment_intent_client_secret = paymentIntent.client_secret;
        } else if (paymentIntent.status === 'succeeded' || paymentIntent.status === 'requires_confirmation') {
            // The payment didn’t need any additional actions and completed!
            // Handle post-payment fulfilment
            try {
                Transaction.wrap(function () {
                    order.addNote('Stripe 3DS', 'requires_action: Confirmed');
                    var placeOrderStatus = OrderMgr.placeOrder(order);
                    if (placeOrderStatus.isError()) {
                        throw new Error();
                    }

                    order.setConfirmationStatus(Order.CONFIRMATION_STATUS_CONFIRMED);
                    order.setExportStatus(Order.EXPORT_STATUS_READY);

                    if (stripeChargeCapture) {
                        order.setPaymentStatus(Order.PAYMENT_STATUS_PAID);
                    }

                    session.privacy.stripeOrderNumber = null;
                    delete session.privacy.stripeOrderNumber;
                });
                COHelpers.sendConfirmationEmail(order, req.locale.id);
                responsePayload.success = true;
            } catch (e) {
                stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder Confirm Payment Intent: Error on paymentIntent.status === succeeded || paymentIntent.status === requires_confirmation');
                responsePayload.error = true;
            }
        } else {
            // Invalid status
            Transaction.wrap(function () {
                order.addNote('Order Failed Reason', 'Invalid payment intent status: ' + paymentIntent.status);
                OrderMgr.failOrder(order, true);
            });
            stripePaymentsHelper.LogStripeErrorMessage('StripePayments.CardPaymentSubmitOrder Confirm Payment Intent: Error on invalid payment intent status: ' + paymentIntent.status);
            Transaction.wrap(function () {
                order.addNote('Stripe Error', 'StripePayments.CardPaymentSubmitOrder Confirm Payment Intent: Error on invalid payment intent status: ' + paymentIntent.status);
            });
            responsePayload.error = {
                message: 'Invalid PaymentIntent status'
            };
        }

        res.json(responsePayload);
        return next();
    } catch (e) {
        responsePayload = {
            error: {
                message: e.message
            }
        };
    }

    res.json(responsePayload);
    return next();
});

module.exports = server.exports();
